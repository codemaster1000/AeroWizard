require('dotenv').config();
const FlightAPI = require('../services/flightAPI');

async function troubleshootAPI() {
    const api = new FlightAPI();
    try {
        console.log('1. Testing API authentication...');
        const token = await api.getAccessToken();
        console.log(`✅ API authentication successful: ${token.substring(0, 10)}...`);
        
        console.log('2. Testing airport code lookup...');
        const nycCode = await api.searchAirport('NYC');
        const lonCode = await api.searchAirport('LON');
        console.log(`✅ Airport codes: NYC -> ${nycCode}, LON -> ${lonCode}`);
        
        console.log('3. Testing flight search with known working route...');
        // Use a date that's likely to have flights and is within API limitations (1-6 months ahead)
        const futureDate = new Date();
        futureDate.setMonth(futureDate.getMonth() + 3);
        const testDate = futureDate.toISOString().split('T')[0];
        
        console.log(`Searching for flights from NYC to LON on ${testDate}`);
        const flights = await api.searchFlights('NYC', 'LON', testDate);
        
        if (flights.length > 0) {
            console.log(`✅ Found ${flights.length} flights!`);
            console.log('First flight:', JSON.stringify(flights[0], null, 2));
        } else {
            console.log('⚠️ No flights found, but API connection is working');
        }
    } catch (error) {
        console.error('❌ API troubleshooting failed:', error);
        console.error('Error details:', error.response?.data || error.message);
    }
}

troubleshootAPI();