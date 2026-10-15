var trafficPriority = {critical: 4, major: 3, minor: 2, low: 1};
var trafficHoldTimes = {critical: 10000, major: 8000, minor: 6000, low: 4000};
// Cross the zoom-13 geometry boundary during the flight, rather than at popup time.
var trafficIncidentZoom = 13.25;

function addTrafficRoadLabels(map) {
  const id = 'traffic-road-names';
  if (map.getLayer(id)) return;
  // The traffic style includes road geometry but no street-name layer.
  map.addLayer({id, type: 'symbol', source: 'composite', 'source-layer': 'road', minzoom: 10,
    filter: ['!=', ['coalesce', ['get', 'name_en'], ['get', 'name'], ['get', 'ref'], ''], ''],
    layout: {'symbol-placement': 'line', 'symbol-spacing': 220,
      'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name'], ['get', 'ref'], ''],
      'text-font': ['Interstate-Bold Regular', 'Arial Unicode MS Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 10, 13, 14, 17],
      'text-padding': 5, 'text-max-angle': 35},
    paint: {'text-color': '#ffffff', 'text-halo-color': '#284c79', 'text-halo-width': 2}});
}

function trafficPopupDescription(incident) {
  const description = incident.desc.trim();
  const separator = description.indexOf(' - ');
  // The location before HERE's separator is already included in the title.
  return separator > 0 ? description.slice(separator + 3).trim() : description;
}

function trafficPopupText(incident) {
  if (incident.title.endsWith(incident.desc)) return {title: incident.desc.trim(), description: ''};
  return {title: incident.title, description: trafficPopupDescription(incident)};
}

function trafficRoadsOverlap(a, b) {
  if (!a.geometry || !b.geometry) return false;
  const lonScale = 111320 * Math.cos(a.coordinates[1] * Math.PI / 180);
  const segments = incident => incident.geometry.coordinates.flatMap(line => line.slice(1).map((point, i) => {
    const start = [line[i][0] * lonScale, line[i][1] * 111320];
    const end = [point[0] * lonScale, point[1] * 111320];
    return {start, end, length: Math.hypot(end[0] - start[0], end[1] - start[1])};
  })).filter(segment => segment.length > 0);
  let shorter = segments(a), longer = segments(b);
  const length = road => road.reduce((sum, segment) => sum + segment.length, 0);
  if (length(shorter) > length(longer)) [shorter, longer] = [longer, shorter];
  const total = length(shorter);
  if (!total || !longer.length) return false;
  let covered = 0;
  for (const segment of shorter) {
    const samples = Math.ceil(segment.length / 100);
    for (let i = 0; i < samples; i++) {
      const fraction = (i + 0.5) / samples;
      const point = segment.start.map((value, axis) => value + (segment.end[axis] - value) * fraction);
      const nearby = longer.some(other => {
        const dx = other.end[0] - other.start[0], dy = other.end[1] - other.start[1];
        const projection = Math.max(0, Math.min(1,
          ((point[0] - other.start[0]) * dx + (point[1] - other.start[1]) * dy) / other.length ** 2));
        return Math.hypot(point[0] - other.start[0] - dx * projection,
          point[1] - other.start[1] - dy * projection) <= 50;
      });
      if (nearby) covered += segment.length / samples;
    }
  }
  return covered / total >= 0.85;
}

function sameTrafficIncident(a, b) {
  if (a.sourceIds.some(id => b.sourceIds.includes(id))) return true;
  if (a.event.originalIds.some(id => b.event.originalIds.includes(id))) return true;
  // Shared pavement alone does not make separate crashes or work projects one event.
  return a.event.type === 'construction' && b.event.type === 'construction'
    && a.event.summary && a.event.summary === b.event.summary
    && a.event.codes && a.event.codes === b.event.codes
    && a.event.roadClosed === b.event.roadClosed
    && Number.isFinite(a.event.start) && Number.isFinite(b.event.start)
    && Math.abs(a.event.start - b.event.start) <= 60000
    && Number.isFinite(a.event.end) && Number.isFinite(b.event.end)
    && Math.abs(a.event.end - b.event.end) <= 60000
    && trafficRoadsOverlap(a, b);
}

function normalizeTrafficIncidents(results) {
  const incidents = (Array.isArray(results) ? results : []).filter(result => result && typeof result === 'object').map((result, index) => {
    const details = result.incidentDetails || {};
    const criticality = Object.hasOwn(trafficPriority, details.criticality) ? details.criticality : 'low';
    const description = details.description?.value || result.location?.description || 'Traffic incident';
    const street = parseStreetName(description) || result.location?.description || description;
    const links = result.location?.shape?.links;
    const lines = [];
    let coordinates = null;
    for (const link of Array.isArray(links) ? links : []) {
      let line = [];
      const saveLine = () => {
        if (line.length > 1 && line.some(point => point[0] !== line[0][0] || point[1] !== line[0][1])) lines.push(line);
        line = [];
      };
      for (const point of Array.isArray(link?.points) ? link.points : []) {
        if (point && typeof point.lat === 'number' && typeof point.lng === 'number'
          && Number.isFinite(point.lat) && Number.isFinite(point.lng)
          && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180) {
          const coordinate = [point.lng, point.lat];
          coordinates ||= coordinate;
          line.push(coordinate);
        } else saveLine();
      }
      saveLine();
    }
    return {
      id: details.id || String(index), criticality,
      sourceIds: details.id ? [details.id] : [],
      event: {originalIds: details.originalId ? [details.originalId] : [], type: details.type,
        summary: (details.summary?.value || '').trim().toLowerCase(),
        codes: Array.isArray(details.codes) ? details.codes.slice().sort().join(',') : '',
        roadClosed: details.roadClosed, start: Date.parse(details.startTime), end: Date.parse(details.endTime)},
      coordinates,
      geometry: lines.length ? {type: 'MultiLineString', coordinates: lines} : null,
      roadLength: Number.isFinite(result.location?.length) ? result.location.length : null,
      title: incidentType(details.type) + street,
      impact: incidentImpact(criticality), desc: description
    };
  });
  const groups = [];
  for (const incident of incidents.sort((a, b) => trafficPriority[b.criticality] - trafficPriority[a.criticality])) {
    const group = groups.find(existing => sameTrafficIncident(existing, incident));
    if (!group) {
      groups.push(incident);
      continue;
    }
    group.sourceIds.push(...incident.sourceIds);
    group.event.originalIds.push(...incident.event.originalIds);
    if (incident.geometry) {
      const lines = [...(group.geometry?.coordinates || []), ...incident.geometry.coordinates];
      group.geometry = {type: 'MultiLineString', coordinates: Array.from(new Map(lines.map(line => [JSON.stringify(line), line])).values())};
    }
    // Prefer a named road range over a generic or single-cross-street description.
    const specificity = item => /^Between /.test(item.desc) ? 2 : parseStreetName(item.desc) ? 1 : 0;
    if (specificity(incident) > specificity(group)) {
      group.title = incident.title;
      group.desc = incident.desc;
      group.coordinates = incident.coordinates || group.coordinates;
    }
    group.coordinates ||= incident.coordinates;
  }
  return groups.slice(0, 6).map(({event, ...incident}) => incident);
}

function trafficIncidentCamera(map, incident) {
  const points = (incident.geometry?.coordinates || []).flat();
  points.push(incident.coordinates);
  if (!incident.geometry) return {center: incident.coordinates, zoom: trafficIncidentZoom, offset: [0, 95]};
  const bounds = [
    [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1]))],
    [Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))]
  ];
  // Reserve the left side for the popup; show the entire affected road to its right.
  const padding = {top: 70, bottom: 70, left: 560, right: 70};
  const camera = map.cameraForBounds(bounds, {padding,
    maxZoom: trafficIncidentZoom, bearing: 0, pitch: 0});
  if (!camera) throw new Error('Unable to frame the traffic incident');
  // A fit just past an integer would switch geometry detail at the very end of the flight.
  const zoom = camera.zoom - Math.floor(camera.zoom) < 0.18 ? Math.max(0, Math.floor(camera.zoom) - 0.08) : camera.zoom;
  return {center: camera.center, zoom, offset: [(padding.left - padding.right) / 2, 0]};
}

class TrafficIncidentTour {
  constructor(options) {
    this.options = options;
    this.map = options.map;
    this.timers = new Set();
    this.listeners = new Set();
    this.active = false;
  }

  schedule(callback, delay) {
    if (!this.active) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.active) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  listen(event, callback) {
    const entry = {event, callback};
    this.listeners.add(entry);
    this.map.on(event, callback);
    return entry;
  }

  unlisten(entry) {
    this.map.off(entry.event, entry.callback);
    this.listeners.delete(entry);
  }

  cancel() {
    this.active = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.listeners) this.map.off(entry.event, entry.callback);
    this.listeners.clear();
    this.map?.stop();
    this.options.onClear?.();
  }

  finish(unavailable = false) {
    if (!this.active) return;
    this.cancel();
    this.options.onComplete(unavailable);
  }

  waitForTiles(callback) {
    let idle;
    const timeout = this.schedule(() => this.finish(true), 8000);
    idle = this.listen('idle', () => {
      if (!this.active || !this.map.areTilesLoaded()) return;
      this.unlisten(idle);
      clearTimeout(timeout);
      this.timers.delete(timeout);
      callback();
    });
  }

  preload(center, zoom, offset) {
    // Warm the next camera path without changing the visible camera or making HERE requests.
    this.map.flyTo({center, zoom, offset, bearing: 0, pitch: 0, padding: 0,
      duration: 2000, preloadOnly: true, essential: true});
  }

  preloadNext(index) {
    const next = this.incidents[index];
    const camera = next ? trafficIncidentCamera(this.map, next)
      : {center: this.options.center, zoom: this.options.zoom, offset: [0, 0]};
    this.preload(camera.center, camera.zoom, camera.offset);
  }

  start() {
    this.cancel();
    this.active = true;
    this.incidents = this.options.incidents.slice();
    if (!this.map) return this.finish(true);
    this.listen('error', () => this.finish(true));
    const ready = () => {
      this.waitForTiles(() => {
        try {
          this.options.onOverview?.();
          if (this.incidents.length) this.preloadNext(0);
          this.schedule(() => this.visit(0), 8000 + (this.options.revealDuration || 0));
        } catch (error) {
          this.finish(true);
        }
      });
      try {
        this.map.jumpTo({center: this.options.center, zoom: this.options.zoom, bearing: 0, pitch: 0, padding: 0});
      } catch (error) {
        return this.finish(true);
      }
    };
    if (this.map.isStyleLoaded()) {
      ready();
    } else {
      const loading = [];
      const timeout = this.schedule(() => this.finish(true), 5000);
      const checkReady = () => {
        if (!this.active || !this.map.isStyleLoaded()) return;
        for (const entry of loading) this.unlisten(entry);
        clearTimeout(timeout);
        this.timers.delete(timeout);
        ready();
      };
      // GeoJSON updates can temporarily unset isStyleLoaded after the one-time load event.
      for (const event of ['load', 'styledata', 'sourcedata', 'idle']) loading.push(this.listen(event, checkReady));
    }
  }

  move(center, zoom, offset, arrived) {
    this.map.stop();
    let settled = false;
    let movement;
    const complete = () => {
      if (settled || !this.active) return;
      settled = true;
      this.unlisten(movement);
      clearTimeout(timeout);
      this.timers.delete(timeout);
      // Let the final detail tiles render before the popup's reading hold begins.
      this.waitForTiles(arrived);
    };
    movement = this.listen('moveend', complete);
    const timeout = this.schedule(() => this.finish(true), 3500);
    try {
      const camera = {center, zoom, offset, bearing: 0, pitch: 0, padding: 0,
        duration: this.options.reducedMotion ? 0 : 2000,
        animate: !this.options.reducedMotion, essential: false};
      // flyTo falls back to jumpTo for reduced motion, which loses the popup offset.
      if (this.options.reducedMotion) this.map.easeTo(camera);
      else this.map.flyTo(camera);
    } catch (error) {
      this.finish(true);
    }
  }

  visit(index) {
    if (!this.active) return;
    this.options.onClear?.();
    if (index >= this.incidents.length) {
      if (!this.incidents.length) return this.finish();
      this.move(this.options.center, this.options.zoom, [0, 0], () => {
        this.options.onOverview?.();
        this.schedule(() => this.finish(), 2000);
      });
      return;
    }
    const incident = this.incidents[index];
    let camera;
    try {
      camera = trafficIncidentCamera(this.map, incident);
      this.options.onPrepareIncident?.(incident);
    } catch (error) {
      return this.finish(true);
    }
    this.move(camera.center, camera.zoom, camera.offset, () => {
      try {
        this.options.onIncident(incident, index, this.incidents.length);
        this.preloadNext(index + 1);
      } catch (error) {
        return this.finish(true);
      }
      this.schedule(() => this.visit(index + 1), (trafficHoldTimes[incident.criticality] || trafficHoldTimes.low)
        + (this.options.popupRevealDuration || 0));
    });
  }
}

var activeTrafficTour = null;
var trafficFallbackIncidents = null;
var trafficIncidentMarker = null;
var trafficIncidentPopup = null;

function setTrafficIncidentRange(incident) {
  const sourceId = 'traffic-incident-range';
  const data = {type: 'FeatureCollection', features: []};
  if (incident?.geometry) data.features.push({type: 'Feature', geometry: incident.geometry,
    properties: {color: trafficIncidentColor(incident)}});
  if (!trafficMap.getSource(sourceId)) {
    if (!data.features.length) return;
    trafficMap.addSource(sourceId, {type: 'geojson', data});
    trafficMap.addLayer({id: sourceId + '-halo', type: 'line', source: sourceId,
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.85}}, 'traffic-road-names');
    trafficMap.addLayer({id: sourceId + '-line', type: 'line', source: sourceId,
      layout: {'line-cap': 'round', 'line-join': 'round'},
      paint: {'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 0.95}}, 'traffic-road-names');
  } else trafficMap.getSource(sourceId).setData(data);
}

function trafficIncidentColor(incident) {
  return {'LOW IMPACT': '#59cb61', 'MEDIUM IMPACT': '#dfcd26', 'HIGH IMPACT': '#bf2026'}[incident.impact];
}

function clearTrafficIncident() {
  trafficIncidentPopup?.remove();
  trafficIncidentMarker?.remove();
  trafficIncidentPopup = null;
  trafficIncidentMarker = null;
  if (typeof trafficMap !== 'undefined' && trafficMap) setTrafficIncidentRange(null);
  deleteTrafficMapIcons();
}

function cancelTrafficTour() {
  activeTrafficTour?.cancel();
  activeTrafficTour = null;
  $('.traffic-overview, .tempunavailable').stop(true, false).hide();
}

function trafficTextIncidents() {
  return trafficFallbackIncidents || weatherData.trafficReport.incidents;
}

function showTrafficIncident(incident, index, total) {
  const color = trafficIncidentColor(incident);
  const pin = document.createElement('div');
  pin.className = 'traffic-incident-pin';
  pin.style.setProperty('--incident-color', color);
  pin.setAttribute('aria-label', incident.title);
  const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  symbol.setAttribute('class', 'traffic-incident-pin-symbol');
  symbol.setAttribute('viewBox', '0 0 46 58');
  symbol.setAttribute('aria-hidden', 'true');
  symbol.innerHTML = '<path d="M14 39L23 58L32 39Z" fill="white"/>'
    + '<circle cx="23" cy="23" r="20" fill="var(--incident-color)" stroke="white" stroke-width="3"/>'
    + '<path d="M23 12V27" stroke="white" stroke-width="4"/>'
    + '<circle cx="23" cy="33" r="2.3" fill="white"/>';
  pin.appendChild(symbol);
  trafficIncidentMarker = new mapboxgl.Marker({element: pin, anchor: 'bottom'})
    .setLngLat(incident.coordinates).addTo(trafficMap);

  const content = document.createElement('div');
  const heading = document.createElement('div');
  heading.className = 'traffic-popup-heading';
  const badge = document.createElement('span');
  badge.className = 'traffic-popup-impact';
  badge.style.backgroundColor = color;
  badge.textContent = incident.impact;
  const progress = document.createElement('span');
  progress.className = 'traffic-popup-progress';
  progress.textContent = `${index + 1} of ${total} · ${incident.criticality[0].toUpperCase() + incident.criticality.slice(1)}`;
  heading.append(badge, progress);
  const popupText = trafficPopupText(incident);
  const title = document.createElement('h3');
  title.textContent = popupText.title;
  const description = document.createElement('p');
  description.className = 'traffic-popup-description';
  description.textContent = popupText.description;
  content.append(heading, title);
  if (popupText.description) content.appendChild(description);
  const contextView = !!incident.geometry;
  trafficIncidentPopup = new mapboxgl.Popup({className: 'traffic-incident-popup',
    anchor: contextView ? 'right' : 'bottom', offset: contextView ? [-34, 0] : [0, -68], maxWidth: '510px', closeButton: false, closeOnClick: false,
    focusAfterOpen: false}).setLngLat(incident.coordinates).setDOMContent(content).addTo(trafficMap);
  if (contextView) {
    const point = trafficMap.project(incident.coordinates);
    const halfHeight = trafficIncidentPopup.getElement().offsetHeight / 2;
    const centerY = Math.max(halfHeight + 12, Math.min(trafficMap.getContainer().clientHeight - halfHeight - 12, point.y - 25));
    trafficIncidentPopup.setOffset([-34, centerY - point.y]);
  }
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    trafficIncidentPopup.getElement().classList.add('traffic-incident-enter');
    pin.classList.add('traffic-incident-enter');
  }
  $('.titletext').text('Traffic Report');
}

function startTrafficOverview() {
  const report = weatherData.trafficReport.incidents.slice();
  const context = [orderidx, gidx, idx];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let revealed = false;
  let tour;
  const stillCurrent = () => activeTrafficTour === tour && context[0] === orderidx
    && context[1] === gidx && context[2] === idx;
  trafficFallbackIncidents = report.filter(incident => !incident.coordinates);
  tour = new TrafficIncidentTour({
    map: weatherData.trafficMapUnavailable ? null : trafficMap,
    incidents: report.filter(incident => incident.coordinates),
    center: [Number(systemSettings.traffic.lon), Number(systemSettings.traffic.lat)],
    zoom: systemSettings.traffic.zoomOut,
    reducedMotion,
    revealDuration: reducedMotion ? 0 : 500,
    popupRevealDuration: reducedMotion ? 0 : 450,
    onClear: clearTrafficIncident,
    onOverview: () => {
      $('.titletext').text('Traffic Overview');
      createTrafficMapIcons(0);
      if (!revealed) {
        revealed = true;
        $('.traffic-overview').css('visibility', 'visible').animate({opacity: 1}, reducedMotion ? 0 : 500);
      }
    },
    onIncident: showTrafficIncident,
    onPrepareIncident: setTrafficIncidentRange,
    onComplete: unavailable => {
      if (!stillCurrent()) return;
      const advance = () => {
        if (!stillCurrent()) return;
        round = 0;
        slideCallBack();
      };
      if (unavailable) {
        weatherData.trafficMapUnavailable = true;
        trafficFallbackIncidents = report;
        $('.traffic-overview').hide();
        $('.tempunavailable').fadeIn(250).delay(1500).fadeOut(250, advance);
      } else {
        $('.traffic-overview').fadeOut(500, advance);
      }
    }
  });
  activeTrafficTour = tour;
  $('.headertext').text(systemSettings.traffic.locationName);
  $('.titletext').text('Traffic Overview');
  audioPlayer.playTrafficCond();
  if (!tour.map) return tour.start();
  // Layout and prepare the main-city camera before any map pixels become visible.
  $('.traffic-overview').css({display: 'block', visibility: 'hidden', opacity: 0});
  const scale = $('#slides').css('scale');
  $('#slides').css('scale', 'none');
  tour.map.resize();
  $('#slides').css('scale', scale);
  tour.start();
}

window.addEventListener('pagehide', () => activeTrafficTour?.cancel());
