require('dotenv').config();
const Database = require('../services/database');

async function testDB() {
    const db = new Database();
    try {
        await db.initialize();
        console.log('✅ Database connection successful');
        await db.close();
    } catch (error) {
        console.error('❌ Database connection failed:', error);
    }
}

testDB();
