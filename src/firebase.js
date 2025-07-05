// Import Firebase modules
import firebase from 'firebase/app';
import 'firebase/database';
import 'firebase/firestore';

// Initialize Firebase
const firebaseConfig = {
    apiKey: 'AIzaSyDsVjBXsYCKlPnOuBmAsEzCNhUa_kMY04o',
    authDomain: 'flight-tracker-bot.firebaseapp.com',
    databaseURL: 'https://flight-tracker-bot-default-rtdb.firebaseio.com/',
    projectId: 'flight-tracker-bot',
    storageBucket: 'flight-tracker-bot.firebasestorage.app',
    messagingSenderId: '183022267498',
    appId: '1:183022267498:web:6f43af6fa93e2855972e13',
    measurementId: "G-146MCEV2ZH"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Reference to the database
const database = firebase.database();
const firestore = firebase.firestore();

// User subscriptions and data
function getSubscriptionInfo(userId) {
    return firestore.collection('users').doc(userId.toString()).get()
        .then(doc => {
            if (doc.exists) {
                return doc.data().subscription_tier || 'free';
            }
            return 'free';
        });
}

function updateSubscription(userId, tier, expiryDate = null) {
    const userData = {
        subscription_tier: tier,
        subscription_updated_at: firebase.firestore.FieldValue.serverTimestamp()
    };
    
    if (expiryDate) {
        userData.subscription_expiry = firebase.firestore.Timestamp.fromDate(expiryDate);
    }
    
    return firestore.collection('users').doc(userId.toString()).update(userData);
}

// Export Firebase modules and helper functions
export {
    firebase,
    database,
    firestore,
    getSubscriptionInfo,
    updateSubscription
};
