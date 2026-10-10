const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../main/js/location.js'), 'utf8');
const main = {locationName: 'Corpus Christi', lat: 27.732, lon: -97.3876, icaoCode: 'KNGP'};
const localCities = [
    ['Corpus Christi', 27.764, -97.403],
    ['Northwest Corpus Christi', 27.779, -97.47],
    ['Robstown', 27.789, -97.668],
    ['Port Aransas', 27.834, -97.062],
    ['Sinton', 28.036, -97.509],
    ['Rockport', 28.02, -97.054],
    ['Orange Grove', 27.956, -97.936],
    ['Kingsville', 27.516, -97.866],
    ['Beeville', 28.401, -97.749],
    ['Alice', 27.752, -98.07]
].map(([displayName, latitude, longitude], i) => ({
    displayName, latitude, longitude, locId: `city-${i}`, stationId: i === 0 ? 'TAQT2' : `K00${i}`
}));

function stations(cities) {
    return {location: {
        stationId: cities.map(city => city.stationId),
        latitude: cities.map(city => city.latitude),
        longitude: cities.map(city => city.longitude)
    }};
}

function contextFor(handler, mainCity = main) {
    const requests = [];
    const context = {
        console,
        systemSettings: {
            apiKeys: {api_key: 'test-only'}, mainCity: {...mainCity},
            nearbyCities: {cities: []}, extraCity: {maxCities: 3, cities: []},
            packageSettings: ['forecast', 'extralocal'],
            LBar: {locations: {cities: [{...mainCity}]}, ccTicker: {cities: []}}
        },
        $: {getJSON: async url => {
            const request = new URL(url);
            requests.push(request);
            return handler(request);
        }}
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return {context, requests};
}

function pointFor(request, cities = localCities) {
    assert.equal(request.searchParams.has('icaoCode'), false);
    const city = cities.find(city => `${city.latitude},${city.longitude}` === request.searchParams.get('geocode'));
    assert.ok(city, 'Look up the coordinates returned by the nearby-station API');
    return {location: city};
}

test('waits for the wider search and shares results with extra forecasts and ticker', async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let nearCalls = 0;
    const {context, requests} = contextFor(async request => {
        if (request.pathname.endsWith('/near')) {
            nearCalls++;
            if (nearCalls === 1) return stations(localCities.slice(0, 4));
            await pending;
            return stations(localCities);
        }
        return pointFor(request);
    });
    let finished = false;
    const search = context.getNearbyCities().then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nearCalls, 2);
    assert.equal(finished, false, 'Startup must wait for the second batch');
    release();
    await search;
    assert.equal(context.systemSettings.nearbyCities.cities.length, 8);
    const count = requests.length;
    await context.getExtraCities();
    await context.getLBarCC();
    assert.equal(requests.length, count, 'Reuse the completed nearby search');
    assert.equal(context.systemSettings.extraCity.cities.length, 3);
    assert.equal(context.systemSettings.LBar.ccTicker.cities.length, 10);
    assert.ok(context.systemSettings.extraCity.cities.every(city => city.locationName !== 'Corpus Christi'));
    assert.ok(context.systemSettings.nearbyCities.cities.every(city => city.header === `geocode=${city.lat},${city.lon}`));
    assert.ok(context.systemSettings.LBar.ccTicker.cities.every(city => city.header === `${city.lat},${city.lon}`));
});

test('resolves KNGP and coastal station identifiers by coordinates, rejecting Putao', async () => {
    const nas = {...localCities[0], stationId: 'KNGP', latitude: 27.7, longitude: -97.283};
    const candidates = [nas, ...localCities];
    const {context, requests} = contextFor(request => {
        if (request.pathname.endsWith('/near')) return stations(candidates);
        if (request.searchParams.get('geocode') === '27.7,-97.283') {
            return {location: {displayName: 'Putao Township', latitude: 27.31, longitude: 97.418}};
        }
        return pointFor(request);
    });
    await context.getNearbyCities();
    await context.getExtraCities();
    assert.equal(context.systemSettings.nearbyCities.cities.length, 8);
    assert.ok(requests.some(request => request.searchParams.get('geocode') === '27.764,-97.403'));
    assert.ok(context.systemSettings.nearbyCities.cities.every(city => city.lon < 0 && !city.obsName.includes('Putao')));
    assert.ok(context.systemSettings.extraCity.cities.every(city => city.lon < 0 && !city.locationName.includes('Putao')));
});

test('IP and ZIP main-city lookups both produce a full nearby list', async () => {
    for (const query of [undefined, '78411']) {
        const {context} = contextFor(request => {
            if (request.hostname === 'pro.ip-api.com') return {city: 'Corpus Christi', lat: main.lat, lon: main.lon};
            if (request.pathname.endsWith('/search')) return {location: {
                ianaTimeZone: ['America/Chicago'], displayName: ['Corpus Christi'],
                latitude: [27.718], longitude: [-97.392], icaoCode: ['KNGW']
            }};
            if (request.pathname.endsWith('/near')) return stations(localCities);
            return pointFor(request);
        });
        context.mainquery = query;
        await context.getMainCity();
        await context.getNearbyCities();
        await context.getExtraCities();
        assert.equal(context.systemSettings.mainCity.locationName, 'Corpus Christi');
        assert.equal(context.systemSettings.nearbyCities.cities.length, 8);
        assert.equal(context.systemSettings.extraCity.cities.length, 3);
    }
});

test('deduplicates towns and bounds sparse searches without background recursion', async () => {
    let nearCalls = 0;
    const duplicate = {...localCities[0], stationId: 'KNGP', latitude: 27.7, longitude: -97.283};
    const {context} = contextFor(request => {
        if (request.pathname.endsWith('/near')) {
            nearCalls++;
            return stations([localCities[0], duplicate, {...duplicate, stationId: 'INVALID', latitude: null}]);
        }
        return {location: localCities[0]};
    });
    await context.getNearbyCities();
    assert.equal(nearCalls, 9, 'Search the original center and eight surrounding centers at most');
    assert.equal(context.systemSettings.nearbyCities.cities.length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(nearCalls, 9, 'No search remains running after startup continues');
});

test('continues after failed batches and point lookups while rejecting distant stations', async () => {
    let nearCalls = 0;
    const remote = {stationId: 'REMOTE', latitude: 48, longitude: -120};
    const broken = {stationId: 'BROKEN', latitude: 27.8, longitude: -97.4};
    const {context, requests} = contextFor(request => {
        if (request.pathname.endsWith('/near')) {
            if (++nearCalls === 1) throw new Error('Temporary failure');
            return stations([remote, broken, ...localCities]);
        }
        if (request.searchParams.get('geocode') === '27.8,-97.4') throw new Error('Station lookup failed');
        return pointFor(request);
    });
    await context.getNearbyCities();
    assert.equal(context.systemSettings.nearbyCities.cities.length, 8);
    assert.ok(requests.every(request => request.searchParams.get('geocode') !== '48,-120'));
});

test('rebuilding extra forecasts does not retain cities from a previous location', async () => {
    const {context} = contextFor(request => request.pathname.endsWith('/near') ? stations(localCities) : pointFor(request));
    await context.getExtraCities();
    context.systemSettings.mainCity = {locationName: 'Remote', lat: 48, lon: -120, icaoCode: 'REMOTE'};
    await context.getExtraCities();
    assert.equal(context.systemSettings.extraCity.cities.length, 0);
    assert.ok(context.systemSettings.packageSettings.every(name => name !== 'extralocal'));
});

test('accepts quoted coordinates from a manual configuration', async () => {
    const {context} = contextFor(request => request.pathname.endsWith('/near') ? stations(localCities) : pointFor(request),
        {...main, lat: String(main.lat), lon: String(main.lon)});
    await context.getNearbyCities();
    assert.equal(context.systemSettings.nearbyCities.cities.length, 8);
});

test('startup uses coordinates for automatic main-city and sidebar observations', async () => {
    for (const query of ['', '?78411']) {
        const {context} = contextFor(request => {
            if (request.hostname === 'pro.ip-api.com') return {city: 'Corpus Christi', lat: main.lat, lon: main.lon};
            if (request.pathname.endsWith('/search')) return {location: {
                ianaTimeZone: ['America/Chicago'], displayName: ['Corpus Christi'],
                latitude: [27.718], longitude: [-97.392], icaoCode: ['KNGW']
            }};
            if (request.pathname.endsWith('/near')) return stations(localCities);
            return pointFor(request);
        });
        const s = context.systemSettings;
        s.mainCity.autoFind = true;
        s.mainCity.radar = {auto: false};
        s.nearbyCities.autoFind = true;
        s.extraCity.autoFind = true;
        s.LBar.locations.autoFind = true;
        s.LBar.radar = {auto: false};
        s.LBar.ccTicker.autoFind = true;
        s.LBar.ccTicker.travelCities = [];
        s.dataMaps = {auto: false};
        s.travel = {regionalMap: {autoFind: false, cities: []}, destinationForecast: []};
        s.health = {autoFind: true};
        s.airport = {autoFind: false};
        s.international = {map: Object.fromEntries(['canada', 'mexico', 'caribbean', 'southamerica', 'britain', 'europe', 'africa', 'india', 'eastasia', 'oceania', 'australia'].map(name => [name, []])), forecast: []};
        s.golf = {autoFind: false, teeTime: {locationID: 'golf'}, courses: []};
        s.garden = {autoFind: false, locationID: 'garden'};
        s.systemLocation = '';
        context.window = {location: {search: query}};
        context.getCoordsLocID = async () => '0,0';
        const getJSON = context.$.getJSON;
        context.$ = () => ({text() {}});
        context.$.getJSON = getJSON;
        await context.locationJS();
        const expected = `geocode=${s.mainCity.lat},${s.mainCity.lon}`;
        assert.equal(s.mainCity.header, expected);
        assert.equal(s.LBar.locations.cities[0].header, expected);
        assert.equal(s.nearbyCities.cities.length, 8);
        assert.ok(s.LBar.ccTicker.cities.every(city => city.header === `${city.lat},${city.lon}`));
    }
});

test('automatic health observations use coordinates while manual station choices remain intact', () => {
    const dataSource = fs.readFileSync(path.join(__dirname, '../main/js/data.js'), 'utf8');
    const start = dataSource.indexOf('function getHealthData()');
    const end = dataSource.indexOf('async function getAirporData()', start);
    for (const automatic of [true, false]) {
        const {context, requests} = contextFor(() => new Promise(() => {}));
        context.systemSettings.health = {...main, autoFind: automatic};
        context.api_key = 'test-only';
        vm.runInContext(dataSource.slice(start, end), context);
        context.getHealthData();
        const current = requests.find(request => request.pathname.endsWith('/observations/current'));
        assert.ok(current);
        assert.equal(current.searchParams.get('geocode'), automatic ? `${main.lat},${main.lon}` : null);
        assert.equal(current.searchParams.get('icaoCode'), automatic ? null : 'KNGP');
    }
});
