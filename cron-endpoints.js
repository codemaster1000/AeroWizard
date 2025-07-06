function setupCronEndpoints(app, priceMonitor, flightTracker) {
    // Price monitor endpoint for Cloud Scheduler
    app.get('/cron/check-prices', (req, res) => {
        // Simple authorization check
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return res.status(403).send('Unauthorized');
        }

        console.log('Running scheduled price check via Cloud Scheduler...');
        priceMonitor.checkAllAlerts()
            .then(() => res.status(200).send('Price check completed'))
            .catch(err => {
                console.error('Error in price check:', err);
                res.status(500).send('Error running price check');
            });
    });

    // Flight status check endpoint for Cloud Scheduler
    app.get('/cron/check-flights', (req, res) => {
        // Simple authorization check
        const authHeader = req.headers.authorization;
        if (!authHeader || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return res.status(403).send('Unauthorized');
        }

        console.log('Running scheduled flight status check via Cloud Scheduler...');
        flightTracker.checkAllTrackedFlights()
            .then(() => res.status(200).send('Flight status check completed'))
            .catch(err => {
                console.error('Error in flight status check:', err);
                res.status(500).send('Error running flight status check');
            });
    });
}

module.exports = setupCronEndpoints;