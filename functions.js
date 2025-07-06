const functions = require('firebase-functions');
const app = require('./index');

// Export the Express API as a Firebase Cloud Function
exports.api = functions.https.onRequest(app);

// Add scheduled functions for price monitoring
exports.scheduledPriceCheck = functions.pubsub
    .schedule('every 4 hours')
    .onRun(async (context) => {
        console.log('Running scheduled price check via Cloud Function...');
        const { priceMonitor } = require('./index');
        await priceMonitor.checkAllAlerts();
        return null;
    });

// Add scheduled functions for flight status checks
exports.scheduledFlightStatusCheck = functions.pubsub
    .schedule('every 30 minutes')
    .onRun(async (context) => {
        console.log('Running scheduled flight status check via Cloud Function...');
        const { flightTracker } = require('./index');
        await flightTracker.checkAllTrackedFlights();
        return null;
    });