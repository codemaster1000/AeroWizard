class PriceMonitor {
    constructor(bot, flightAPI, database, userStates) {
        this.bot = bot;
        this.flightAPI = flightAPI;
        this.db = database;
        this.userStates = userStates;
        this.isRunning = false;
    }

    async checkAllAlerts() {
        if (this.isRunning) {
            console.log('Price check already running, skipping...');
            return;
        }

        this.isRunning = true;
        console.log('Starting price check for all alerts...');

        try {
            // Clean up old alerts first
            await this.db.cleanupOldAlerts();

            // Get all active alerts
            const alerts = await this.db.getActiveAlerts();
            console.log(`Found ${alerts.length} active alerts to check`);

            for (const alert of alerts) {
                try {
                    await this.checkSingleAlert(alert.alert_id);
                    // Add delay between checks to respect API limits
                    await this.sleep(2000);
                } catch (error) {
                    console.error(`Error checking alert ${alert.alert_id}:`, error.message);
                    continue;
                }
            }

            console.log('Completed price check for all alerts');
        } catch (error) {
            console.error('Error in checkAllAlerts:', error);
        } finally {
            this.isRunning = false;
        }
    }

    async checkSingleAlert(alertId) {
        try {
            console.log(`Checking price for alert ${alertId}...`);

            // 1. Get the alert details
            const alert = await this.db.getAlert(alertId);
            if (!alert) {
                console.error(`Alert ${alertId} not found`);
                return;
            }

            console.log(`Alert details: ${alert.origin} to ${alert.destination} on ${alert.departure_date}`);

            // 2. Search for flights with error handling
            let flights = [];
            try {
                flights = await this.flightAPI.searchFlights(
                    alert.origin,
                    alert.destination,
                    alert.departure_date,
                    alert.return_date
                );

                console.log(`Found ${flights.length} flights for alert ${alertId}`);
            } catch (apiError) {
                console.error(`API error for alert ${alertId}:`, apiError.message);
                // Update the alert's last check timestamp but don't modify price
                await this.db.updateAlertCheck(alertId, null);
                return;
            }

            if (!flights || flights.length === 0) {
                console.log(`No flights found for alert ${alertId}`);
                await this.db.updateAlertCheck(alertId, null);
                return;
            }

            // 3. Find cheapest flight
            let cheapestFlight = flights[0];
            let cheapestPrice = parseFloat(cheapestFlight.price);

            flights.forEach(flight => {
                const currentPrice = parseFloat(flight.price);
                if (currentPrice < cheapestPrice) {
                    cheapestPrice = currentPrice;
                    cheapestFlight = flight;
                }
            });

            // 4. Get previous price for comparison
            const previousPrice = alert.current_price;

            // 5. Determine if we should notify
            const notification = this.shouldNotifyUser(alert, cheapestPrice, previousPrice);

            // 6. Update price in database
            await this.db.updateAlertPrice(alertId, cheapestPrice);

            // 7. Notify user if needed
            if (notification.notify) {
                await this.sendPriceAlert(alert, cheapestFlight, notification.reason, previousPrice);
            }

        } catch (error) {
            console.error(`Error checking single alert ${alertId}:`, error);
            // If it's an API error, don't fail silently - log it but continue
            if (error.message.includes('No flights found')) {
                console.log(`No flights found for alert ${alertId}, will try again later`);
            }
        }
    }

    shouldNotifyUser(alert, currentPrice, previousPrice) {
        // Notify on any price change if min_price is 0 (price tracking mode)
        if (alert.min_price === 0 && previousPrice && currentPrice !== previousPrice) {
            return {
                notify: true,
                reason: currentPrice < previousPrice ? 'price_drop' : 'price_increase'
            };
        }

        // Original logic for target-based tracking
        if (currentPrice <= alert.min_price) {
            return {
                notify: true,
                reason: 'target_reached'
            };
        }

        if (previousPrice && currentPrice < previousPrice) {
            const dropAmount = previousPrice - currentPrice;
            const dropPercentage = (dropAmount / previousPrice) * 100;

            if (dropAmount >= 50 && dropPercentage >= 20) {
                return {
                    notify: true,
                    reason: 'significant_drop'
                };
            }
        }

        if (!previousPrice) {
            return {
                notify: true,
                reason: 'first_check'
            };
        }

        return { notify: false };
    }

    async sendPriceAlert(alert, flightData, reason, previousPrice = null) {
        try {
            let message = '';
            let emoji = '';

            switch (reason) {
                case 'target_reached':
                    emoji = '🎯';
                    message = `${emoji} TARGET PRICE REACHED!\n\n`;
                    break;
                case 'significant_drop':
                    emoji = '📉';
                    message = `${emoji} SIGNIFICANT PRICE DROP!\n\n`;
                    break;
                case 'price_drop':
                    emoji = '📉';
                    message = `${emoji} PRICE DROPPED!\n\n`;
                    break;
                case 'price_increase':
                    emoji = '📈';
                    message = `${emoji} PRICE INCREASED!\n\n`;
                    break;
                case 'first_check':
                    emoji = '✅';
                    message = `${emoji} Flight tracking started!\n\n`;
                    break;
            }

            message += `📍 Route: <b>${alert.origin} → ${alert.destination}</b>\n`;
            message += `📅 Departure: ${alert.departure_date}\n`;

            if (alert.return_date) {
                message += `🔄 Return: ${alert.return_date}\n`;
            }

            message += `\n💰 Current Price: <b>$${flightData.price}</b>\n`;

            if (previousPrice && reason !== 'first_check') {
                const savings = previousPrice - flightData.price;
                if (savings > 0) {
                    message += `💸 You saved: <b>$${savings}</b> (was $${previousPrice})\n`;
                }
            }

            // Only show target price if it's not zero (not "any price change" mode)
            if (alert.min_price > 0) {
                message += `🎯 Your target: <b>$${alert.min_price}</b>\n`;
            }
            message += `✈️ Airline: ${flightData.airline}\n`;

            if (flightData.details) {
                message += `📝 Details: ${flightData.details}\n`;
            }

            // Replace the existing line with this to make it clickable:
            if (flightData.bookingUrl && (flightData.bookingUrl.startsWith('http://') || flightData.bookingUrl.startsWith('https://'))) {
                message += `\n🔗 <a href="${flightData.bookingUrl}">Book now: Click here</a>\n`;
            } else {
                message += `\n🔗 Book now: Not available\n`;
            }

            // Keep the alert ID
            message += `\n🆔 Alert ID: ${alert.alert_id}`;

            // Add quick action buttons
            let inlineKeyboard = {
                inline_keyboard: [
                    [
                        {
                            text: '📊 Price History',
                            callback_data: `history_${alert.alert_id}`
                        },
                        {
                            text: '❌ Cancel Alert',
                            callback_data: `cancel_${alert.alert_id}`
                        }
                    ]
                ]
            };

            // Only add the View Flight button if we have a valid URL
            if (flightData.bookingUrl && (flightData.bookingUrl.startsWith('http://') || flightData.bookingUrl.startsWith('https://'))) {
                inlineKeyboard.inline_keyboard.push([
                    {
                        text: '✈️ View Flight',
                        url: flightData.bookingUrl
                    }
                ]);
            }

            // Make sure you're passing the inline_keyboard properly
            await this.bot.sendMessage(alert.telegram_id, message, {
                parse_mode: 'HTML',
                reply_markup: inlineKeyboard // Must be passed as reply_markup
            });
        } catch (error) {
            console.error('Error sending price alert:', error);
        }
    }

    async handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const userId = callbackQuery.from.id;
        const data = callbackQuery.data;

        try {
            // Handle price history callback
            if (data.startsWith('history_')) {
                const alertId = data.split('_')[1];
                await this.sendPriceHistory(chatId, alertId, userId);
                await this.bot.answerCallbackQuery(callbackQuery.id);
                return true;
            }
            // Handle track callback from search results
            if (data.startsWith('track_')) {

                /*

                // Check premium status first
                const isPremium = await this.db.isUserPremium(userId);
                if (!isPremium) {
                    await this.bot.sendMessage(chatId, '⭐ This is a Premium Feature ⭐\n\nUpgrade to premium to track flight prices.\nUse /premium to learn more.');
                    await this.bot.answerCallbackQuery(callbackQuery.id);
                    return;
                }
                */

                const parts = data.split('_');
                if (parts.length < 4) return;

                const origin = parts[1];
                const destination = parts[2];
                const departureDate = parts[3];
                const returnDate = parts.length > 4 ? parts[4] : null;

                // Set up the user state for completing the tracking
                this.userStates.set(userId, {
                    step: 'track_target_price',
                    data: {
                        origin,
                        destination,
                        departure_date: departureDate,
                        return_date: returnDate
                    }
                });

                await this.bot.sendMessage(chatId, '💰 What\'s your target price? I\'ll alert you when flights drop to this price or below. (e.g., 500)');
                await this.bot.answerCallbackQuery(callbackQuery.id);
                return;
            }

            if (data.startsWith('origin_')) {
                const index = parseInt(data.split('_')[1]);
                const airports = userState.data.airports;

                if (airports && airports[index]) {
                    const selectedAirport = airports[index];
                    userState.data.origin = selectedAirport.code;
                    userState.data.originName = selectedAirport.name;
                    userState.step = 'search_destination';
                    userStates.set(userId, userState);

                    await bot.sendMessage(chatId,
                        `✅ Selected departure: ${selectedAirport.name} (${selectedAirport.code})
            
🎯 Which city are you flying TO?`);
                    await bot.answerCallbackQuery(callbackQuery.id);
                }
                return;
            }

            if (data.startsWith('dest_')) {
                const index = parseInt(data.split('_')[1]);
                const userState = this.userStates.get(userId);

                if (userState && userState.data.airports && userState.data.airports[index]) {
                    const selectedAirport = userState.data.airports[index];
                    userState.data.destination = selectedAirport.code;
                    userState.data.destinationName = selectedAirport.name;
                    userState.step = 'search_departure_date';
                    this.userStates.set(userId, userState);

                    await this.bot.sendMessage(chatId,
                        `✅ Selected destination: ${selectedAirport.name} (${selectedAirport.code})
            
📅 What's your departure date? (YYYY-MM-DD format, e.g., 2024-12-25)`);
                    await this.bot.answerCallbackQuery(callbackQuery.id);
                }
                return;
            }

            if (data.startsWith('pause_')) {
                const alertId = data.split('_')[1];
                await this.pauseAlert(chatId, alertId, userId);

                // Use global reference to handleMyAlerts from index.js if available
                try {
                    if (global.handleMyAlerts) {
                        setTimeout(() => global.handleMyAlerts(chatId, userId), 500);
                    }
                } catch (e) {
                    console.error('Error refreshing alerts view:', e);
                }
            } else if (data.startsWith('cancel_')) {
                const alertId = data.split('_')[1];
                await this.cancelAlert(chatId, alertId, userId);

                // Use global reference to handleMyAlerts from index.js if available
                try {
                    if (global.handleMyAlerts) {
                        setTimeout(() => global.handleMyAlerts(chatId, userId), 500);
                    }
                } catch (e) {
                    console.error('Error refreshing alerts view:', e);
                }
            }

            // Answer the callback query
            await this.bot.answerCallbackQuery(callbackQuery.id);

        } catch (error) {
            console.error('Error handling callback query:', error);
            await this.bot.answerCallbackQuery(callbackQuery.id, {
                text: 'Error processing request',
                show_alert: true
            });
        }
    }

    async sendPriceHistory(chatId, alertId, userId) {
        try {
            console.log(`Attempting to send price history - alertId: ${alertId}, userId: ${userId}`);

            // Verify user owns this alert using Firestore
            const alert = await this.db.getAlert(alertId);
            console.log(`Alert found:`, alert);

            // Convert both to strings for comparison
            const alertUserId = String(alert?.telegram_id);
            const currentUserId = String(userId);
            console.log(`User ID match check: ${alertUserId} === ${currentUserId}`);

            if (!alert || alertUserId !== currentUserId) {
                console.log(`❌ Alert not found or access denied. Alert: ${JSON.stringify(alert)}`);
                await this.bot.sendMessage(chatId, '❌ Alert not found or access denied.');
                return;
            }

            // Get price history from Firestore
            const history = await this.db.getPriceHistory(userId, alertId, 10);

            if (history.length === 0) {
                await this.bot.sendMessage(chatId, '📊 No price history available yet.');
                return;
            }

            let message = `📊 Price History for <b>${alert.origin} → ${alert.destination}</b>\n\n`;

            history.forEach((entry, index) => {
                const date = new Date(entry.timestamp).toLocaleDateString();
                const time = new Date(entry.timestamp).toLocaleTimeString();
                message += `${index + 1}. $${entry.price} - ${date} ${time}\n`;
                if (entry.airline) {
                    message += `   ✈️ ${entry.airline}\n`;
                }
            });

            const minPrice = Math.min(...history.map(h => h.price));
            const maxPrice = Math.max(...history.map(h => h.price));
            const avgPrice = Math.round(history.reduce((sum, h) => sum + h.price, 0) / history.length);

            message += `\n📈 Statistics:\n`;
            message += `• Lowest: <b>$${minPrice}</b>\n`;
            message += `• Highest: <b>$${maxPrice}</b>\n`;
            message += `• Average: <b>$${avgPrice}</b>\n`;
            message += `• Your target: <b>$${alert.min_price}</b>`;

            await this.bot.sendMessage(chatId, message);

        } catch (error) {
            console.error('Error sending price history:', error);
            await this.bot.sendMessage(chatId, '❌ Error fetching price history.');
        }
    }

    async pauseAlert(chatId, alertId, userId) {
        try {
            // For now, we'll just deactivate the alert (you can implement pause logic later)
            await this.db.cancelAlert(alertId, userId);
            await this.bot.sendMessage(chatId, `⏸️ Alert ${alertId} has been paused.`);
        } catch (error) {
            console.error('Error pausing alert:', error);
            await this.bot.sendMessage(chatId, '❌ Error pausing alert.');
        }
    }

    async cancelAlert(chatId, alertId, userId) {
        try {
            await this.db.cancelAlert(alertId, userId);
            await this.bot.sendMessage(chatId, `❌ Alert ${alertId} has been cancelled.`);
        } catch (error) {
            console.error('Error cancelling alert:', error);
            await this.bot.sendMessage(chatId, '❌ Error cancelling alert.');
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // Weekly summary feature
    async sendWeeklySummary() {
        try {
            console.log('Sending weekly summaries...');

            // Get all users with active alerts using Firestore
            const usersWithAlerts = await this.db.getUsersWithActiveAlerts();

            for (const userId of usersWithAlerts) {
                try {
                    await this.sendUserWeeklySummary(userId);
                    await this.sleep(1000); // Rate limiting
                } catch (error) {
                    console.error(`Error sending weekly summary to ${userId}:`, error);
                }
            }

        } catch (error) {
            console.error('Error in sendWeeklySummary:', error);
        }
    }

    async sendUserWeeklySummary(telegramId) {
        try {
            const stats = await this.db.getUserStats(telegramId);
            const alerts = await this.db.getUserAlerts(telegramId);

            if (alerts.length === 0) return;

            let message = `📊 Your Weekly Flight Summary\n\n`;
            message += `✈️ Active Alerts: ${alerts.filter(a => a.is_active).length}\n`;

            // Calculate average price from active alerts
            const activeAlerts = alerts.filter(a => a.is_active && a.current_price);
            const avgPrice = activeAlerts.length > 0 ?
                Math.round(activeAlerts.reduce((sum, a) => sum + a.current_price, 0) / activeAlerts.length) : 0;

            message += `💰 Average Price: $${avgPrice}\n`;

            if (stats && stats.best_deal_saved) {
                message += `🏆 Best Deal Found: $${stats.best_deal_saved}\n`;
            }

            message += `\n📈 Recent Activity:\n`;

            // Show top 3 alerts by activity
            const topAlerts = alerts.slice(0, 3);
            topAlerts.forEach((alert, index) => {
                message += `${index + 1}. ${alert.origin} → ${alert.destination}\n`;
                message += `   Current: $${alert.current_price || 'Checking...'} | Target: $${alert.min_price}\n`;
            });

            message += `\nUse /myalerts to manage your alerts.`;

            await this.bot.sendMessage(telegramId, message);

        } catch (error) {
            console.error(`Error sending user weekly summary:`, error);
        }
    }
}

module.exports = PriceMonitor;
