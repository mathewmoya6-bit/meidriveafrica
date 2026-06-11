import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const BACKEND_URL = process.env.BACKEND_URL || 'https://meidriveafrica-backend.onrender.com';

// ============================================
// M-PESA CREDENTIALS - PRODUCTION (REAL MONEY)
// ============================================
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || 'LI2gcJZEheN8qCfXHEXV4gdYXvOBHVnv';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'aGGo8AuPJVpsZLcs';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '7eb17a031bdfd5b4251863a1ddb72c5b9cd14f3385aa6a258c1442a0116e8277';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '4095377';
const MPESA_CALLBACK_URL = `${BACKEND_URL}/api/payments/mpesa/callback`;

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    console.log(`📝 ${req.method} ${req.url}`);
    next();
});

// Timeout middleware
app.use((req, res, next) => {
    req.setTimeout(120000);
    res.setTimeout(120000);
    next();
});

// ============================================
// HEALTH CHECK ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        message: 'MEI DRIVE AFRICA API is running',
        environment: 'production',
        mpesa_configured: true,
        paybill: MPESA_SHORTCODE
    });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function getTimestamp() {
    const date = new Date();
    return date.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function formatPhoneNumber(phoneNumber) {
    let cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.startsWith('0')) cleaned = '254' + cleaned.substring(1);
    else if (cleaned.startsWith('+254')) cleaned = cleaned.substring(1);
    else if (!cleaned.startsWith('254')) cleaned = '254' + cleaned;
    
    if (!cleaned.startsWith('254') || cleaned.length !== 12) {
        throw new Error('Invalid phone number. Use format: 0712345678');
    }
    return cleaned;
}

async function getMpesaAccessToken() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    console.log('🔑 Getting M-Pesa access token...');
    
    const response = await axios.get(
        'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
        { headers: { Authorization: `Basic ${auth}` }, timeout: 30000 }
    );
    
    if (!response.data.access_token) {
        throw new Error('No access token received from Safaricom');
    }
    
    console.log('✅ M-Pesa access token obtained');
    return response.data.access_token;
}

// Store pending transactions
const transactions = new Map();

// ============================================
// M-PESA STK PUSH INITIATE
// ============================================

app.post('/api/payments/mpesa/initiate', async (req, res) => {
    try {
        const { phoneNumber, amount, courseId, userId, email, courseName } = req.body;
        
        console.log('========================================');
        console.log('💰 STK PUSH INITIATION');
        console.log('========================================');
        console.log('Phone:', phoneNumber);
        console.log('Amount:', amount);
        console.log('Course ID:', courseId);
        console.log('========================================');
        
        if (!phoneNumber) {
            return res.status(400).json({ success: false, error: 'Phone number is required' });
        }
        
        if (!amount || amount < 1) {
            return res.status(400).json({ success: false, error: 'Valid amount is required' });
        }
        
        const formattedPhone = formatPhoneNumber(phoneNumber);
        console.log('Formatted Phone:', formattedPhone);
        
        // Get access token
        const accessToken = await getMpesaAccessToken();
        
        const timestamp = getTimestamp();
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        
        const stkRequest = {
            BusinessShortCode: MPESA_SHORTCODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: 'CustomerPayBillOnline',
            Amount: Math.round(amount),
            PartyA: formattedPhone,
            PartyB: MPESA_SHORTCODE,
            PhoneNumber: formattedPhone,
            CallBackURL: MPESA_CALLBACK_URL,
            AccountReference: `MEI${courseId}`,
            TransactionDesc: `MEI DRIVE - ${courseName || 'Course'}`
        };
        
        console.log('📤 Sending STK Push to Safaricom...');
        console.log('Callback URL:', MPESA_CALLBACK_URL);
        
        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
            stkRequest,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 35000
            }
        );
        
        console.log('✅ STK Push Response:', response.data);
        
        if (response.data.ResponseCode !== '0') {
            throw new Error(response.data.ResponseDescription || 'STK Push failed');
        }
        
        // Store transaction
        transactions.set(response.data.CheckoutRequestID, {
            status: 'pending',
            userId,
            courseId,
            amount,
            email,
            courseName,
            phone: formattedPhone,
            createdAt: new Date().toISOString()
        });
        
        res.json({
            success: true,
            checkoutRequestID: response.data.CheckoutRequestID,
            message: 'STK Push sent. Check your phone for M-Pesa prompt.',
            warning: '⚠️ REAL MONEY will be deducted from your M-Pesa account'
        });
        
    } catch (error) {
        console.error('❌ Payment error:', error.message);
        console.error('Response:', error.response?.data);
        
        res.status(500).json({
            success: false,
            error: error.response?.data?.errorMessage || error.message,
            code: error.response?.data?.errorCode || 'UNKNOWN_ERROR'
        });
    }
});

// ============================================
// CHECK PAYMENT STATUS
// ============================================

app.post('/api/payments/mpesa/status', async (req, res) => {
    try {
        const { checkoutRequestID } = req.body;
        
        if (!checkoutRequestID) {
            return res.status(400).json({ success: false, error: 'CheckoutRequestID required' });
        }
        
        console.log(`🔍 Checking payment status for: ${checkoutRequestID}`);
        
        const accessToken = await getMpesaAccessToken();
        const timestamp = getTimestamp();
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');
        
        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query',
            {
                BusinessShortCode: MPESA_SHORTCODE,
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: checkoutRequestID
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );
        
        const isCompleted = response.data.ResultCode === '0';
        console.log(`📊 Status: ${isCompleted ? 'COMPLETED' : 'PENDING'}`);
        
        res.json({
            success: true,
            status: isCompleted ? 'completed' : 'pending',
            resultCode: response.data.ResultCode,
            resultDesc: response.data.ResultDesc
        });
        
    } catch (error) {
        console.error('Status check error:', error.message);
        res.status(500).json({
            success: false,
            status: 'failed',
            error: error.message
        });
    }
});

// ============================================
// M-PESA CALLBACK (Webhook)
// ============================================

app.post('/api/payments/mpesa/callback', (req, res) => {
    console.log('📞 M-Pesa Callback received at:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    const { Body } = req.body;
    
    if (Body && Body.stkCallback) {
        const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;
        
        const transaction = transactions.get(CheckoutRequestID);
        
        if (ResultCode === 0 && CallbackMetadata) {
            const items = CallbackMetadata.Item || [];
            const receiptNumber = items.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
            const amount = items.find(item => item.Name === 'Amount')?.Value;
            const phoneNumber = items.find(item => item.Name === 'PhoneNumber')?.Value;
            
            if (transaction) {
                transaction.status = 'completed';
                transaction.transaction_id = receiptNumber;
                transaction.completed_amount = amount;
            }
            
            console.log(`✅ PAYMENT SUCCESSFUL!`);
            console.log(`   Receipt: ${receiptNumber}`);
            console.log(`   Amount: KES ${amount}`);
            console.log(`   Phone: ${phoneNumber}`);
            console.log(`   CheckoutID: ${CheckoutRequestID}`);
        } else {
            console.log(`❌ PAYMENT FAILED: ${ResultDesc}`);
            if (transaction) transaction.status = 'failed';
        }
    }
    
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ============================================
// ENROLLMENT ENDPOINT
// ============================================

app.post('/api/enroll', (req, res) => {
    console.log('📋 Enrollment request:', req.body);
    res.json({ success: true, message: 'Enrollment successful' });
});

// ============================================
// TEST M-PESA ENDPOINT
// ============================================

app.get('/api/payments/mpesa/test', async (req, res) => {
    try {
        await getMpesaAccessToken();
        res.json({
            success: true,
            message: 'M-Pesa API connection successful',
            paybill: MPESA_SHORTCODE,
            mode: 'PRODUCTION - REAL MONEY',
            warning: '⚠️ Real money will be deducted from customer accounts'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            paybill: MPESA_SHORTCODE
        });
    }
});

// ============================================
// DEBUG ENDPOINT
// ============================================

app.get('/api/debug/credentials', (req, res) => {
    res.json({
        consumer_key_length: MPESA_CONSUMER_KEY.length,
        consumer_secret_length: MPESA_CONSUMER_SECRET.length,
        passkey_length: MPESA_PASSKEY.length,
        shortcode: MPESA_SHORTCODE,
        callback_url: MPESA_CALLBACK_URL,
        backend_url: BACKEND_URL,
        status: 'Credentials configured',
        warning: 'Production mode - REAL MONEY'
    });
});

// ============================================
// ROOT ENDPOINT
// ============================================

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'MEI DRIVE AFRICA API',
        version: '2.1.0',
        status: 'running',
        paybill: MPESA_SHORTCODE,
        endpoints: [
            'GET  /',
            'GET  /health',
            'GET  /api/health',
            'GET  /api/payments/mpesa/test',
            'GET  /api/debug/credentials',
            'POST /api/payments/mpesa/initiate',
            'POST /api/payments/mpesa/status',
            'POST /api/payments/mpesa/callback',
            'POST /api/enroll'
        ]
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        message: `Cannot ${req.method} ${req.url}`
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Global error:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error'
    });
});

// ============================================
// START SERVER
// ============================================

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║                                                                   ║
║     🚗 MEI DRIVE AFRICA - M-PESA API SERVER                       ║
║     🟢 Version: 2.1.0                                            ║
║                                                                   ║
║     Status: ✅ RUNNING                                            ║
║     Port: ${PORT}                                                   ║
║     Paybill: ${MPESA_SHORTCODE}                                     ║
║     Environment: PRODUCTION                                       ║
║                                                                   ║
║     ⚠️  REAL MONEY WILL BE DEDUCTED!                              ║
║                                                                   ║
║     Health: ${BACKEND_URL}/health                                  ║
║     Test: ${BACKEND_URL}/api/payments/mpesa/test                   ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

export default app;
