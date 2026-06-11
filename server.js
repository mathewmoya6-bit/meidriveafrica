fix here import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const BACKEND_URL = process.env.BACKEND_URL || 'https://meidriveafrica-backend.onrender.com';

// M-Pesa Credentials - PRODUCTION (REAL MONEY)
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || 'LI2gcJZEheN8qCfXHEXV4gdYXvOBHVnv';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || 'aGGo8AuPJVpsZLcs';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '7eb17a031bdfd5b4251863a1ddb72c5b9cd14f3385aa6a258c1442a0116e8277';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '4095377';
const MPESA_CALLBACK_URL = `${BACKEND_URL}/api/payments/mpesa/callback`;

// CORS configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// ============================================
// TIMEOUT HANDLING FIXES - CRITICAL FOR RENDER
// ============================================

// Increase server timeout
app.use((req, res, next) => {
    req.setTimeout(120000); // 2 minutes
    res.setTimeout(120000);
    next();
});

// Health check with response time tracking
app.get('/api/health', (req, res) => {
    const startTime = Date.now();
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        responseTime: Date.now() - startTime,
        message: 'MEI DRIVE AFRICA API is running',
        environment: process.env.NODE_ENV || 'production',
        mpesa_configured: true,
        paybill: MPESA_SHORTCODE
    });
});

// Simple root health check for Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// ============================================
// HELPER FUNCTIONS WITH BETTER ERROR HANDLING
// ============================================

function getTimestamp() {
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

async function getMpesaAccessToken() {
    const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString('base64');
    console.log('🔑 Attempting to get M-Pesa token...');
    
    try {
        const response = await axios.get(
            'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { 
                headers: { Authorization: `Basic ${auth}` }, 
                timeout: 30000 
            }
        );
        
        if (!response.data.access_token) {
            throw new Error('No access token received from Safaricom');
        }
        
        console.log('✅ M-Pesa access token obtained successfully');
        return response.data.access_token;
    } catch (error) {
        console.error('❌ Error getting M-Pesa token:');
        console.error('Status:', error.response?.status);
        console.error('Message:', error.message);
        
        // Don't throw for network errors - return null and let caller handle
        if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND') {
            throw new Error('Network error connecting to Safaricom. Please check your internet connection.');
        }
        
        throw new Error(`Failed to get M-Pesa token: ${error.response?.data?.errorMessage || error.message}`);
    }
}

function formatPhoneNumber(phoneNumber) {
    let cleaned = phoneNumber.replace(/\D/g, '');
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('+254')) {
        cleaned = cleaned.substring(1);
    } else if (cleaned.length === 9) {
        cleaned = '254' + cleaned;
    } else if (cleaned.length === 10 && cleaned.startsWith('254')) {
        cleaned = cleaned;
    } else if (!cleaned.startsWith('254')) {
        cleaned = '254' + cleaned;
    }
    
    if (!cleaned.startsWith('254') || cleaned.length !== 12) {
        throw new Error('Invalid phone number. Please enter a valid 10-digit Safaricom number (e.g., 0712345678)');
    }
    
    return cleaned;
}

// ============================================
// M-PESA TEST ENDPOINT
// ============================================

app.get('/api/payments/mpesa/test', async (req, res) => {
    const startTime = Date.now();
    try {
        const token = await getMpesaAccessToken();
        res.json({ 
            success: true, 
            message: 'M-Pesa API connection successful',
            paybill: MPESA_SHORTCODE,
            mode: 'PRODUCTION - REAL MONEY',
            responseTime: `${Date.now() - startTime}ms`,
            warning: '⚠️ Real money will be deducted from customer accounts'
        });
    } catch (error) {
        console.error('Test endpoint error:', error.message);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            mode: 'PRODUCTION',
            paybill: MPESA_SHORTCODE,
            responseTime: `${Date.now() - startTime}ms`
        });
    }
});

// ============================================
// STK PUSH INITIATE - WITH RETRY LOGIC
// ============================================

app.post('/api/payments/mpesa/initiate', async (req, res) => {
    const requestStartTime = Date.now();
    let retryCount = 0;
    const maxRetries = 2;
    
    const attemptPayment = async () => {
        try {
            let { phoneNumber, amount, courseId, userId, email, accountReference, transactionDesc } = req.body;

            console.log('========================================');
            console.log(`📱 STK PUSH INITIATION - Attempt ${retryCount + 1}`);
            console.log('========================================');
            console.log('Raw Phone:', phoneNumber);
            console.log('Amount:', amount);
            console.log('Course ID:', courseId);
            console.log('========================================');

            if (!phoneNumber) {
                throw new Error('Phone number is required');
            }

            if (!amount || amount < 1) {
                throw new Error('Valid amount (min 1 KES) is required');
            }

            if (amount > 150000) {
                throw new Error('Amount cannot exceed 150,000 KES');
            }

            let formattedPhone;
            try {
                formattedPhone = formatPhoneNumber(phoneNumber);
            } catch (error) {
                throw new Error(error.message);
            }
            console.log('Formatted Phone:', formattedPhone);

            // Get Access Token with timeout
            console.log('🔑 Getting access token...');
            const accessToken = await getMpesaAccessToken();
            console.log('✅ Access token obtained');

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
                AccountReference: accountReference || `C${courseId || '0'}`,
                TransactionDesc: transactionDesc || 'MEI DRIVE COURSE'
            };

            console.log('📤 Sending STK Push to Safaricom...');

            const stkResponse = await axios.post(
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

            console.log('✅ STK Push Response:', stkResponse.data);

            if (stkResponse.data.ResponseCode !== '0') {
                throw new Error(stkResponse.data.ResponseDescription || 'STK Push failed');
            }

            return {
                success: true,
                checkoutRequestID: stkResponse.data.CheckoutRequestID,
                merchantRequestID: stkResponse.data.MerchantRequestID,
                message: 'STK push sent. Check your phone for M-Pesa prompt.',
                warning: '⚠️ REAL MONEY will be deducted from your M-Pesa account',
                paybill: MPESA_SHORTCODE,
                responseTime: `${Date.now() - requestStartTime}ms`
            };

        } catch (error) {
            console.error(`❌ Attempt ${retryCount + 1} failed:`, error.message);
            throw error;
        }
    };
    
    // Execute with retry logic
    while (retryCount < maxRetries) {
        try {
            const result = await attemptPayment();
            return res.json(result);
        } catch (error) {
            retryCount++;
            if (retryCount === maxRetries) {
                console.error('❌ All payment attempts failed');
                return res.status(500).json({
                    success: false,
                    error: error.message || 'Payment initiation failed after multiple attempts',
                    responseTime: `${Date.now() - requestStartTime}ms`,
                    message: 'Please try again or contact support if issue persists.'
                });
            }
            console.log(`🔄 Retrying payment (${retryCount}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
});

// ============================================
// CHECK PAYMENT STATUS
// ============================================

app.post('/api/payments/mpesa/status', async (req, res) => {
    try {
        const { checkoutRequestID } = req.body;

        if (!checkoutRequestID) {
            return res.status(400).json({
                success: false,
                error: 'CheckoutRequestID required'
            });
        }

        console.log(`🔍 Checking payment status for: ${checkoutRequestID}`);

        const accessToken = await getMpesaAccessToken();
        const timestamp = getTimestamp();
        const password = Buffer.from(`${MPESA_SHORTCODE}${MPESA_PASSKEY}${timestamp}`).toString('base64');

        const statusResponse = await axios.post(
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

        const resultCode = statusResponse.data.ResultCode;
        const isCompleted = resultCode === '0';
        const resultDesc = statusResponse.data.ResultDesc;

        console.log(`📊 Status: ${isCompleted ? 'COMPLETED' : 'PENDING'} - ${resultDesc}`);

        res.json({
            success: true,
            status: isCompleted ? 'completed' : 'pending',
            message: resultDesc,
            resultCode: resultCode,
            resultDesc: resultDesc
        });

    } catch (error) {
        console.error('Status check error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            status: 'failed',
            error: error.response?.data?.errorMessage || error.message
        });
    }
});

// ============================================
// M-PESA CALLBACK (Webhook)
// ============================================

app.post('/api/payments/mpesa/callback', (req, res) => {
    console.log('📞 M-Pesa Callback received at:', new Date().toISOString());
    
    const { Body } = req.body;
    if (Body && Body.stkCallback) {
        const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = Body.stkCallback;

        if (ResultCode === 0) {
            const items = CallbackMetadata?.Item || [];
            const receiptNumber = items.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
            const amount = items.find(item => item.Name === 'Amount')?.Value;
            const phoneNumber = items.find(item => item.Name === 'PhoneNumber')?.Value;

            console.log(`✅ PAYMENT SUCCESSFUL!`);
            console.log(`   Receipt: ${receiptNumber}`);
            console.log(`   Amount: KES ${amount}`);
            console.log(`   Phone: ${phoneNumber}`);
            console.log(`   CheckoutID: ${CheckoutRequestID}`);
        } else {
            console.log(`❌ PAYMENT FAILED: ${ResultDesc}`);
            console.log(`   Result Code: ${ResultCode}`);
            console.log(`   CheckoutID: ${CheckoutRequestID}`);
        }
    } else {
        console.log('⚠️ No stkCallback in webhook body');
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

// ============================================
// ADDITIONAL M-PESA ENDPOINTS
// ============================================

app.post('/api/payments/mpesa/timeout', (req, res) => {
    console.log('⏰ M-Pesa Timeout received:', JSON.stringify(req.body, null, 2));
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

app.post('/api/payments/mpesa/result', (req, res) => {
    console.log('📊 M-Pesa Result received:', JSON.stringify(req.body, null, 2));
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

app.post('/api/payments/mpesa/confirmation', (req, res) => {
    console.log('✅ M-Pesa Confirmation received:', JSON.stringify(req.body, null, 2));
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
});

app.post('/api/payments/mpesa/validation', (req, res) => {
    console.log('🔐 M-Pesa Validation received:', JSON.stringify(req.body, null, 2));
    res.json({ ResultCode: 0, ResultDesc: 'Success' });
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
        port: PORT,
        warning: 'Credentials are configured but may need verification with Safaricom'
    });
});

// ============================================
// ROOT ENDPOINTS
// ============================================

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'MEI DRIVE AFRICA API',
        version: '2.1.0',
        status: 'running',
        paybill: MPESA_SHORTCODE,
        environment: process.env.NODE_ENV || 'production',
        endpoints: [
            'GET  /',
            'GET  /health',
            'GET  /api/health',
            'GET  /api/payments/mpesa/test',
            'GET  /api/debug/credentials',
            'POST /api/payments/mpesa/initiate',
            'POST /api/payments/mpesa/status',
            'POST /api/payments/mpesa/callback'
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
    console.error('Global error handler:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error'
    });
});

// ============================================
// START SERVER WITH PROPER HANDLING
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
║     Paybill Number: ${MPESA_SHORTCODE}                              ║
║     Backend URL: ${BACKEND_URL}                                     ║
║     Environment: ${process.env.NODE_ENV || 'production'}            ║
║                                                                   ║
║     ⚠️  WARNING: REAL MONEY WILL BE DEDUCTED!                     ║
║                                                                   ║
║     Health Check:                                                 ║
║     GET ${BACKEND_URL}/health                                       ║
║                                                                   ║
║     Test M-Pesa Connection:                                       ║
║     GET ${BACKEND_URL}/api/payments/mpesa/test                     ║
║                                                                   ║
╚═══════════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

export default app;
