const admin = require('firebase-admin');
const serviceAccount = require('../firebase_setup/serviceAccountKey.json');

class FirebaseService {
    constructor() {
        // Initialize Firebase if not already initialized
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }

        this.db = admin.firestore();
        this.admin = admin;
    }

    async initialize() {
        try {
            // Firebase doesn't need table creation as collections are created dynamically
            console.log('Firebase service initialized successfully');
        } catch (error) {
            console.error('Firebase initialization error:', error);
            throw error;
        }
    }

    async createUser(telegramId, username) {
        const userRef = this.db.collection('users').doc(telegramId.toString());

        try {
            // Check if user exists
            const doc = await userRef.get();

            if (!doc.exists) {
                // Create new user
                await userRef.set({
                    telegram_id: telegramId,
                    username: username,
                    subscription_tier: 'free',
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                    last_active: admin.firestore.FieldValue.serverTimestamp()
                });
            } else {
                // Update existing user
                await userRef.update({
                    username: username,
                    last_active: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            return telegramId;
        } catch (error) {
            console.error('Error creating user:', error);
            throw error;
        }
    }

    async createAlert(alertData) {
        try {
            const userId = alertData.userId.toString();
            const userRef = this.db.collection('users').doc(userId);

            // Check if user exists, if not create a minimal user record
            const userDoc = await userRef.get();
            if (!userDoc.exists) {
                await userRef.set({
                    telegram_id: alertData.userId,
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                    last_active: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // Create a new alert in the user's flight_alerts subcollection
            const alertsCollectionRef = userRef.collection('flight_alerts');
            const newAlertRef = alertsCollectionRef.doc();

            // Create alert data object with all fields
            const alertDoc = {
                alert_id: newAlertRef.id, // Store ID in the document too for easier access
                origin: alertData.origin,
                destination: alertData.destination,
                departure_date: alertData.departure_date,
                return_date: alertData.return_date,
                min_price: alertData.min_price,
                current_price: alertData.current_price || null,
                is_active: true,
                created_at: admin.firestore.FieldValue.serverTimestamp()
            };

            // Add booking URL if provided
            if (alertData.bookingUrl) {
                alertDoc.booking_url = alertData.bookingUrl;
            }

            await newAlertRef.set(alertDoc);

            // Update user's last_active timestamp
            await userRef.update({
                last_active: admin.firestore.FieldValue.serverTimestamp()
            });

            return newAlertRef.id;
        } catch (error) {
            console.error('Error creating alert:', error);
            throw error;
        }
    }

    async createFlightTrack(trackData) {
        try {
            const { userId, telegramId, carrierCode, flightNumber, date, origin, destination, isSegment, segmentIndex, parentRoute } = trackData;
            const userIdStr = (userId || telegramId).toString();

            const userRef = this.db.collection('users').doc(userIdStr);

            // Check if user exists, if not create a minimal user record
            const userDoc = await userRef.get();
            if (!userDoc.exists) {
                await userRef.set({
                    telegram_id: parseInt(userIdStr) || userIdStr,
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                    last_active: admin.firestore.FieldValue.serverTimestamp()
                });
            }

            // Create a new track in the user's flight_tracks subcollection
            const tracksCollectionRef = userRef.collection('flight_tracks');
            const newTrackRef = tracksCollectionRef.doc();

            // Create the base track object
            const track = {
                track_id: newTrackRef.id, // Store ID in the document too
                carrier_code: carrierCode,
                flight_number: flightNumber,
                date: date,
                origin: origin || null,
                destination: destination || null,
                last_status: JSON.stringify({
                    status: "SCHEDULED",
                    departureTime: null,
                    arrivalTime: null,
                    terminal: null,
                    gate: null,
                    checked: new Date().toISOString()
                }),
                created_at: new Date().toISOString(),
                active: true
            };

            // Add multi-segment journey data if applicable
            if (isSegment) {
                track.is_segment = true;
                track.segment_index = segmentIndex;
                track.parent_route = parentRoute;
            }

            await newTrackRef.set(track);

            // Update user's last_active timestamp
            await userRef.update({
                last_active: admin.firestore.FieldValue.serverTimestamp()
            });

            return newTrackRef.id;
        } catch (error) {
            console.error('Error creating flight track:', error);
            throw error;
        }
    }

    async getUserAlerts(telegramId) {
        try {
            const userRef = this.db.collection('users').doc(telegramId.toString());
            const alertsSnapshot = await userRef.collection('flight_alerts')
                .where('is_active', '==', true)
                .orderBy('created_at', 'desc')
                .get();

            const alerts = [];
            alertsSnapshot.forEach(doc => {
                const data = doc.data();
                alerts.push({
                    alert_id: doc.id,
                    origin: data.origin,
                    destination: data.destination,
                    departure_date: data.departure_date,
                    return_date: data.return_date,
                    min_price: data.min_price,
                    current_price: data.current_price,
                    lowest_price: data.lowest_price,
                    created_at: data.created_at?.toDate(),
                    last_checked: data.last_checked?.toDate()
                });
            });

            return alerts;
        } catch (error) {
            console.error('Error fetching user alerts:', error);
            throw error;
        }
    }

    async getUsersWithActiveAlerts() {
        try {
            // Query all flight_alerts across all users
            const alertsSnapshot = await this.db.collectionGroup('flight_alerts')
                .where('is_active', '==', true)
                .get();

            // Create a Set to avoid duplicates
            const userIds = new Set();

            alertsSnapshot.forEach(doc => {
                const pathSegments = doc.ref.path.split('/');
                const userId = pathSegments[1]; // users/{userId}/flight_alerts/{alertId}
                userIds.add(userId);
            });

            return Array.from(userIds);
        } catch (error) {
            console.error('Error getting users with active alerts:', error);
            return [];
        }
    }

    async getAlert(alertId, userId = null) {
        try {
            if (userId) {
                // If we know the user ID, query directly
                const userRef = this.db.collection('users').doc(userId.toString());
                const alertRef = userRef.collection('flight_alerts').doc(alertId);
                const alertDoc = await alertRef.get();

                if (!alertDoc.exists) {
                    return null;
                }

                const data = alertDoc.data();
                return {
                    alert_id: alertId,
                    telegram_id: userId,
                    origin: data.origin,
                    destination: data.destination,
                    departure_date: data.departure_date,
                    return_date: data.return_date,
                    min_price: data.min_price,
                    current_price: data.current_price,
                    lowest_price: data.lowest_price,
                    is_active: data.is_active,
                    created_at: data.created_at?.toDate(),
                    last_checked: data.last_checked?.toDate(),
                    booking_url: data.booking_url
                };
            } else {
                // If user ID is unknown, search all users for this document ID
                const usersSnapshot = await this.db.collection('users').get();

                for (const userDoc of usersSnapshot.docs) {
                    const userId = userDoc.id;
                    const alertRef = userDoc.ref.collection('flight_alerts').doc(alertId);
                    const alertDoc = await alertRef.get();

                    if (alertDoc.exists) {
                        const data = alertDoc.data();
                        return {
                            alert_id: alertId,
                            telegram_id: userId,
                            origin: data.origin,
                            destination: data.destination,
                            departure_date: data.departure_date,
                            return_date: data.return_date,
                            min_price: data.min_price,
                            current_price: data.current_price,
                            lowest_price: data.lowest_price,
                            is_active: data.is_active,
                            created_at: data.created_at?.toDate(),
                            last_checked: data.last_checked?.toDate(),
                            booking_url: data.booking_url
                        };
                    }
                }

                // Not found in any user's collection
                return null;
            }
        } catch (error) {
            console.error('Error getting alert:', error);
            return null; // Return null instead of throwing to simplify error handling
        }
    }

    async updateAlertCheck(alertId, price = null) {
        try {
            const alertSnapshot = await this.db.collectionGroup('flight_alerts')
                .where('alert_id', '==', alertId)
                .limit(1)
                .get();

            if (alertSnapshot.empty) {
                throw new Error(`Alert ${alertId} not found`);
            }

            const alertDoc = alertSnapshot.docs[0];
            const updateData = {
                last_checked: admin.firestore.FieldValue.serverTimestamp()
            };

            if (price !== null) {
                updateData.current_price = price;
            }

            await alertDoc.ref.update(updateData);
        } catch (error) {
            console.error('Error updating alert check:', error);
            throw error;
        }
    }

    async getActiveAlerts() {
        try {
            // Use a collection group query to search across all users' alert subcollections
            const alertsSnapshot = await this.db.collectionGroup('flight_alerts')
                .where('is_active', '==', true)
                .orderBy('last_checked', 'asc')
                .get();

            const alerts = [];

            alertsSnapshot.forEach(doc => {
                const data = doc.data();
                // Get the user ID from the path
                const pathSegments = doc.ref.path.split('/');
                const userId = pathSegments[1]; // users/{userId}/flight_alerts/{alertId}

                alerts.push({
                    alert_id: doc.id,
                    telegram_id: userId,
                    origin: data.origin,
                    destination: data.destination,
                    departure_date: data.departure_date,
                    return_date: data.return_date,
                    min_price: data.min_price,
                    current_price: data.current_price,
                    last_checked: data.last_checked?.toDate()
                });
            });

            return alerts;
        } catch (error) {
            console.error('Error fetching active alerts:', error);
            throw error;
        }
    }

    async updateAlertPrice(alertId, currentPrice, bookingUrl = null) {
        try {
            // Use the getAlert method which now uses direct document lookups
            const alert = await this.getAlert(alertId);

            if (!alert) {
                throw new Error(`Alert ${alertId} not found`);
            }

            // Now that we have the alert and know its userId, we can update directly
            const userRef = this.db.collection('users').doc(String(alert.telegram_id));
            const alertRef = userRef.collection('flight_alerts').doc(alertId);

            const lowestPrice = alert.lowest_price ?
                Math.min(alert.lowest_price, currentPrice) :
                currentPrice;

            const updateData = {
                current_price: currentPrice,
                lowest_price: lowestPrice,
                last_checked: admin.firestore.FieldValue.serverTimestamp()
            };

            if (bookingUrl) {
                updateData.booking_url = bookingUrl;
            }

            await alertRef.update(updateData);

            // Add price history entry
            await this.addPriceHistory(
                alert.telegram_id,
                alertId,
                currentPrice,
                null,
                bookingUrl
            );

            return true;
        } catch (error) {
            console.error('Error updating alert price:', error);
            throw error;
        }
    }

    async addPriceHistory(userId, alertId, price, airline = null, bookingUrl = null) {
        try {
            const userRef = this.db.collection('users').doc(userId.toString());
            const historyCollectionRef = userRef.collection('price_history');

            await historyCollectionRef.add({
                alert_id: alertId,
                price: price,
                airline: airline,
                booking_url: bookingUrl,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error adding price history:', error);
            throw error;
        }
    }

    async cancelAlert(alertId, telegramId) {
        try {
            const userRef = this.db.collection('users').doc(telegramId.toString());
            const alertsRef = userRef.collection('flight_alerts');

            // Try to find the alert by ID within this user's subcollection
            const alertSnapshot = await alertsRef
                .where('alert_id', '==', alertId)
                .limit(1)
                .get();

            if (alertSnapshot.empty) {
                // If not found in the user's collection, try a global search
                const globalAlertSnapshot = await this.db.collectionGroup('flight_alerts')
                    .where('alert_id', '==', alertId)
                    .limit(1)
                    .get();

                if (globalAlertSnapshot.empty) {
                    throw new Error('Alert not found');
                }

                // Check if the alert belongs to this user
                const alertDoc = globalAlertSnapshot.docs[0];
                const pathSegments = alertDoc.ref.path.split('/');
                const ownerId = pathSegments[1]; // users/{userId}/flight_alerts/{alertId}

                if (ownerId !== telegramId.toString()) {
                    throw new Error('Alert not owned by user');
                }

                await alertDoc.ref.update({ is_active: false });
                return;
            }

            // Update the alert found in the user's collection
            await alertSnapshot.docs[0].ref.update({ is_active: false });
        } catch (error) {
            console.error('Error cancelling alert:', error);
            throw error;
        }
    }

    async getUserStats(telegramId) {
        try {
            const userRef = this.db.collection('users').doc(telegramId.toString());
            const alertsRef = userRef.collection('flight_alerts');

            const alertsSnapshot = await alertsRef.get();

            let totalAlerts = 0;
            let activeAlerts = 0;
            let totalPrice = 0;
            let priceCount = 0;
            let bestDealSaved = Number.MAX_VALUE;

            alertsSnapshot.forEach(doc => {
                const data = doc.data();
                totalAlerts++;

                if (data.is_active) {
                    activeAlerts++;
                }

                if (data.current_price) {
                    totalPrice += data.current_price;
                    priceCount++;
                }

                if (data.lowest_price && data.lowest_price < bestDealSaved) {
                    bestDealSaved = data.lowest_price;
                }
            });

            return {
                total_alerts: totalAlerts,
                active_alerts: activeAlerts,
                avg_current_price: priceCount > 0 ? totalPrice / priceCount : null,
                best_deal_saved: bestDealSaved !== Number.MAX_VALUE ? bestDealSaved : null
            };
        } catch (error) {
            console.error('Error fetching user stats:', error);
            throw error;
        }
    }

    async getPriceHistory(userId, alertId, limit = 50) {
        try {
            console.log(`Getting price history for userId=${userId}, alertId=${alertId}`);
            const userRef = this.db.collection('users').doc(userId.toString());
            const historyRef = userRef.collection('price_history');

            // Use only the filter without ordering to avoid need for composite index
            const historySnapshot = await historyRef
                .where('alert_id', '==', alertId)
                .get();

            const history = [];
            historySnapshot.forEach(doc => {
                const data = doc.data();
                history.push({
                    price: data.price,
                    airline: data.airline,
                    booking_url: data.booking_url,
                    timestamp: data.timestamp?.toDate()
                });
            });

            // Sort in memory
            history.sort((a, b) => b.timestamp - a.timestamp);

            // Apply limit after sorting
            return history.slice(0, limit);
        } catch (error) {
            console.error('Error fetching price history:', error);
            return []; // Return empty array instead of throwing error
        }
    }

    // Get all active flight tracks across all users
    async getAllActiveFlightTracks() {
        try {
            // Get all users first
            const usersSnapshot = await this.db.collection('users').get();
            const tracks = [];

            // Loop through users and get their active tracks
            for (const userDoc of usersSnapshot.docs) {
                const userId = userDoc.id;
                const tracksSnapshot = await userDoc.ref.collection('flight_tracks')
                    .where('active', '==', true)
                    .get();

                tracksSnapshot.forEach(doc => {
                    tracks.push({
                        track_id: doc.id,
                        telegram_id: userId,
                        ...doc.data()
                    });
                });
            }

            // Sort tracks by created_at in memory
            tracks.sort((a, b) => {
                const dateA = new Date(a.created_at);
                const dateB = new Date(b.created_at);
                return dateB - dateA; // descending order
            });

            return tracks;
        } catch (error) {
            console.error('Error fetching active flight tracks:', error);
            return [];
        }
    }

    // Get a specific flight track
    async getFlightTrack(trackId) {
        try {
            // First try a direct approach - look through all users
            const usersSnapshot = await this.db.collection('users').get();

            // Loop through users to find the flight track
            for (const userDoc of usersSnapshot.docs) {
                const trackDoc = await userDoc.ref.collection('flight_tracks').doc(trackId).get();

                if (trackDoc.exists) {
                    const userId = userDoc.id;
                    return {
                        track_id: trackId,
                        telegram_id: userId,
                        ...trackDoc.data()
                    };
                }
            }

            // If direct approach fails, try collection group query
            // This might be the one failing, but we'll try it as a fallback
            const trackSnapshot = await this.db.collectionGroup('flight_tracks')
                .where('track_id', '==', trackId)
                .limit(1)
                .get();

            if (trackSnapshot.empty) {
                // If both approaches fail, try one more thing - if the document exists by ID
                // but doesn't have a track_id field matching the ID
                const usersSnapshot2 = await this.db.collection('users').get();
                for (const userDoc of usersSnapshot2.docs) {
                    const tracksSnapshot = await userDoc.ref.collection('flight_tracks').get();
                    for (const doc of tracksSnapshot.docs) {
                        if (doc.id === trackId) {
                            return {
                                track_id: trackId,
                                telegram_id: userDoc.id,
                                ...doc.data()
                            };
                        }
                    }
                }

                return null;
            }

            const trackDoc = trackSnapshot.docs[0];
            // Get the user ID from the path
            const pathSegments = trackDoc.ref.path.split('/');
            const userId = pathSegments[1]; // users/{userId}/flight_tracks/{trackId}

            return {
                track_id: trackDoc.id,
                telegram_id: userId,
                ...trackDoc.data()
            };
        } catch (error) {
            console.error('Error fetching flight track:', error);
            return null;
        }
    }

    // Get user's flight tracks
    async getUserFlightTracks(telegramId) {
        try {
            const userRef = this.db.collection('users').doc(telegramId.toString());
            const tracksRef = userRef.collection('flight_tracks');

            const tracksSnapshot = await tracksRef
                .where('active', '==', true)
                .orderBy('created_at', 'desc')
                .get();

            const tracks = [];
            tracksSnapshot.forEach(doc => {
                // Include all fields, including multi-segment related fields
                tracks.push({
                    track_id: doc.id,
                    ...doc.data()
                });
            });

            return tracks;
        } catch (error) {
            console.error('Error fetching user flight tracks:', error);
            return [];
        }
    }

    // Update flight track status
    async updateFlightTrackStatus(trackId, statusData) {
        try {
            // First try the direct approach - get the track by ID
            const track = await this.getFlightTrack(trackId);

            if (!track || !track.telegram_id) {
                throw new Error(`Flight track ${trackId} not found`);
            }

            // Now that we know the user ID, we can query directly
            const userRef = this.db.collection('users').doc(track.telegram_id.toString());
            const trackRef = userRef.collection('flight_tracks').doc(trackId);

            await trackRef.update({
                last_status: JSON.stringify(statusData),
                last_checked: new Date().toISOString()
            });

            return true;
        } catch (error) {
            console.error('Error updating flight track status:', error);
            return false;
        }
    }

    // Just update the check time
    async updateFlightTrackCheckTime(trackId) {
        try {
            // First try the direct approach - get the track by ID
            const track = await this.getFlightTrack(trackId);

            if (!track || !track.telegram_id) {
                throw new Error(`Flight track ${trackId} not found`);
            }

            // Now that we know the user ID, we can query directly
            const userRef = this.db.collection('users').doc(track.telegram_id.toString());
            const trackRef = userRef.collection('flight_tracks').doc(trackId);

            await trackRef.update({
                last_checked: new Date().toISOString()
            });

            return true;
        } catch (error) {
            console.error('Error updating flight track check time:', error);
            return false;
        }
    }

    // Cancel a flight track
    async cancelFlightTrack(trackId, userId) {
        try {
            const userIdStr = userId.toString();
            const userRef = this.db.collection('users').doc(userIdStr);
            const tracksRef = userRef.collection('flight_tracks');

            // First try to find the track in this user's collection
            let trackDoc = null;
            let trackRef = null;

            const userTrackSnapshot = await tracksRef
                .where('track_id', '==', trackId)
                .limit(1)
                .get();

            if (!userTrackSnapshot.empty) {
                trackDoc = userTrackSnapshot.docs[0];
                trackRef = trackDoc.ref;
            } else {
                // If not found in user's collection, search globally
                const globalTrackSnapshot = await this.db.collectionGroup('flight_tracks')
                    .where('track_id', '==', trackId)
                    .limit(1)
                    .get();

                if (globalTrackSnapshot.empty) {
                    console.error(`Track ${trackId} not found`);
                    return false;
                }

                trackDoc = globalTrackSnapshot.docs[0];

                // Check if the user owns this track
                const pathSegments = trackDoc.ref.path.split('/');
                const ownerId = pathSegments[1]; // users/{userId}/flight_tracks/{trackId}

                if (ownerId !== userIdStr) {
                    console.error(`User ${userId} does not own track ${trackId}`);
                    return false;
                }

                trackRef = trackDoc.ref;
            }

            // Update the track to mark it as inactive
            await trackRef.update({
                active: false,
                cancelled_at: new Date().toISOString()
            });

            console.log(`Successfully cancelled flight track ${trackId}`);
            return true;
        } catch (error) {
            console.error(`Error cancelling flight track ${trackId}:`, error);
            throw error;
        }
    }

    async cleanupOldAlerts() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            // We need to query all flight_alerts subcollections
            const alertsSnapshot = await this.db.collectionGroup('flight_alerts')
                .where('is_active', '==', true)
                .where('departure_date', '<', today.toISOString().split('T')[0])
                .get();

            let count = 0;
            const batch = this.db.batch();

            alertsSnapshot.forEach(doc => {
                batch.update(doc.ref, { is_active: false });
                count++;
            });

            if (count > 0) {
                await batch.commit();
                console.log(`Cleaned up ${count} old alerts`);
            }

            return count;
        } catch (error) {
            console.error('Error cleaning up old alerts:', error);
            throw error;
        }
    }

    async close() {
        // Firebase handles connection closing automatically
        return true;
    }

    async getUserSubscription(telegramId) {
        try {
            const userRef = this.db.collection('users').doc(telegramId.toString());
            const doc = await userRef.get();

            if (!doc.exists) {
                return { tier: 'free' };
            }

            const userData = doc.data();
            return {
                tier: userData.subscription_tier || 'free',
                expiry: userData.subscription_expiry?.toDate() || null
            };
        } catch (error) {
            console.error('Error fetching user subscription:', error);
            return { tier: 'free' };
        }
    }

    async updateUserSubscription(telegramId, tier, expiryDate = null) {
        try {
            const userRef = this.db.collection('users').doc(telegramId.toString());

            const updateData = {
                subscription_tier: tier,
                subscription_updated_at: admin.firestore.FieldValue.serverTimestamp()
            };

            if (expiryDate) {
                updateData.subscription_expiry = admin.firestore.Timestamp.fromDate(expiryDate);
            }

            await userRef.update(updateData);
            return true;
        } catch (error) {
            console.error('Error updating user subscription:', error);
            throw error;
        }
    }

    async isUserPremium(telegramId) {
        try {
            const subscription = await this.getUserSubscription(telegramId);

            if (subscription.tier === 'premium') {
                // Check if subscription is still valid
                if (!subscription.expiry || new Date() < subscription.expiry) {
                    return true;
                }
            }

            return false;
        } catch (error) {
            console.error('Error checking premium status:', error);
            return false;
        }
    }
}

module.exports = FirebaseService;