const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function trafficContext(handler, routes = []) {
    const context = {
        systemSettings: {
            mainCity: {locationName: 'Corpus Christi', lat: 27.8, lon: -97.4},
            traffic: {autoFind: true, locationName: 'Old City', lat: 0, lon: 0, routes}
        },
        weatherData: {
            trafficReport: {incidents: [], noReport: true},
            trafficFlow: {routes: [], noReport: true}
        },
        traf_key: 'test-only',
        console: {error() {}},
        $: {getJSON: handler},
        incidentType: type => type === 'construction' ? 'Construction, ' : 'Incident, ',
        parseStreetName: description => description.split(' - ')[0],
        incidentImpact: () => 'HIGH IMPACT',
        metStoMPH: speed => Math.round(speed * 2.236936)
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../main/js/location.js'), 'utf8'), context);
    const source = fs.readFileSync(path.join(__dirname, '../main/js/data.js'), 'utf8');
    vm.runInContext(source.slice(source.indexOf('async function getTrafficData()'), source.indexOf('async function getTravelData()')), context);
    return context;
}

test('automatic traffic follows changes to the main city; manual traffic stays configured', () => {
    const context = trafficContext();
    context.setTrafficLocation();
    assert.equal(context.systemSettings.traffic.locationName, 'Corpus Christi');
    assert.equal(context.systemSettings.traffic.lon, -97.4);
    context.systemSettings.mainCity = {locationName: 'Chicago', lat: 41.88, lon: -87.63};
    context.setTrafficLocation();
    assert.equal(context.systemSettings.traffic.locationName, 'Chicago');
    assert.equal(context.systemSettings.traffic.lat, 41.88);
    assert.equal(context.systemSettings.traffic.lon, -87.63);
    context.systemSettings.traffic.autoFind = false;
    context.systemSettings.mainCity.locationName = 'New York';
    context.setTrafficLocation();
    assert.equal(context.systemSettings.traffic.locationName, 'Chicago');
});

test('waits for incidents even without routes and queries the resolved city', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const requests = [];
    const context = trafficContext(url => {
        requests.push(new URL(url));
        return pending;
    }, [{from: '', to: ''}]);
    context.setTrafficLocation();
    let finished = false;
    const loading = context.getTrafficData().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false);
    assert.equal(requests[0].searchParams.get('in'), 'circle:27.8,-97.4;r=4000');
    release({results: [{incidentDetails: {
        type: 'construction', criticality: 'major', description: {value: 'I-37 - Road closed'}
    }}]});
    await loading;
    assert.equal(context.weatherData.trafficReport.incidents.length, 1);
    assert.equal(context.weatherData.trafficReport.locationName, 'Corpus Christi');
    assert.equal(context.weatherData.trafficFlow.routes.length, 0);
    assert.equal(context.weatherData.trafficFlow.noReport, true);
    assert.equal(requests.length, 1, 'Blank routes must not call the routing API');
});

test('filters empty routes and keeps valid route results contiguous', async () => {
    const requests = [];
    const context = trafficContext(async url => {
        const request = new URL(url);
        requests.push(request);
        if (request.pathname.includes('incidents')) return {results: []};
        return {routes: [{sections: [{summary: {length: 10000, baseDuration: 600, duration: 900}}]}]};
    }, [{from: '', to: ''}, {from: '27.8,-97.4', to: '27.9,-97.5', fromStreet: 'A', toStreet: 'B', routeIcon: 'i37'}]);
    context.setTrafficLocation();
    await context.getTrafficData();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get('origin'), '27.8,-97.4');
    assert.equal(context.weatherData.trafficFlow.routes.length, 1);
    assert.equal(context.weatherData.trafficFlow.routes[0].from, 'A');
    assert.equal(context.weatherData.trafficFlow.noReport, false);
});
