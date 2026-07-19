require('dotenv').config();

const express = require('express');
const app = express();
const session = require('express-session');
const bodyParser = require('body-parser');
const ejsLayouts = require('express-ejs-layouts');
const flash = require('connect-flash');
const passport = require('passport');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const chatServices = require('./services/chatServices');


const initAllModels = require('./initAllModels');
initAllModels();

const PORT = process.env.PORT || 5000;

// ===== EJS SETUP =====
app.set('view engine', 'ejs');
app.use(ejsLayouts);
app.use(express.static(path.join(__dirname, './', 'public')));

// ===== MIDDLEWARE SETUP =====|
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));

// ===== SESSION SETUP =====
// Determine if we're in production or development
const isProduction = process.env.NODE_ENV === 'production';
console.log(`Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`);

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        // Secure cookies only in production (HTTPS)
        secure: isProduction,
        // Use 'none' for cross-site in production, 'lax' for local
        sameSite: isProduction ? 'none' : 'lax',
    },
    store: new session.MemoryStore()
});

app.use(sessionMiddleware);

app.use(flash());
app.use(passport.initialize());
app.use(passport.session());

// Flash message usage
app.use((req, res, next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.warning_msg = req.flash('warning_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.error = req.flash('error');
    res.locals.user = req.user || null;
    res.locals.isAuthenticated = req.isAuthenticated();
    next();
});

// API detection middleware
app.use((req, res, next) => {
    req.isAPI = req.originalUrl.startsWith("/api");
    next();
});




// Message expiry configuration
const MESSAGE_EXPIRY_HOURS = process.env.MESSAGE_EXPIRY_HOURS || 24; // Default 24 hours
const MESSAGE_CLEANUP_INTERVAL = 60 * 60 * 1000; // Check every hour

// Function to clean up expired messages
async function cleanupExpiredMessages() {
    try {
        const expiryDate = new Date(Date.now() - (MESSAGE_EXPIRY_HOURS * 60 * 60 * 1000));
        console.log(` Cleaning up messages older than: ${expiryDate.toISOString()}`);

        const result = await chatServices.deleteExpiredMessages(expiryDate);

        if (result.success && result.deletedCount > 0) {
            console.log(` Cleaned up ${result.deletedCount} expired messages`);

            // Notify all clients about expired messages
            io.emit('messages-expired', {
                timestamp: new Date().toISOString(),
                count: result.deletedCount
            });
        }
    } catch (error) {
        console.error('Error cleaning up expired messages:', error);
    }
}

// Run cleanup every hour
setInterval(cleanupExpiredMessages, MESSAGE_CLEANUP_INTERVAL);

// Also run on startup (after a short delay)
setTimeout(cleanupExpiredMessages, 5000);

// ===== SERVER & SOCKET.IO SETUP =====
const server = http.createServer(app);

// Configure CORS for Socket.IO
let corsOptions;
if (isProduction) {
    // Production settings
    const allowedOrigins = process.env.ALLOWED_ORIGINS ?
        process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()) :
        [];

    console.log(' Production mode - Allowed origins:', allowedOrigins);

    corsOptions = {
        origin: function (origin, callback) {
            // Allow requests with no origin (like mobile apps or curl requests)
            if (!origin) {
                console.log('⚠️ Request with no origin, allowing...');
                return callback(null, true);
            }

            // Check if origin is in allowed list
            if (allowedOrigins.length === 0) {
                console.log('⚠️ No allowed origins configured, allowing all');
                return callback(null, true);
            }

            if (allowedOrigins.includes(origin)) {
                return callback(null, true);
            }

            console.error(` CORS blocked origin: ${origin}`);
            return callback(new Error('Not allowed by CORS'), false);
        },
        methods: ['GET', 'POST'],
        credentials: true
    };
} else {
    // Development settings
    console.log('Development mode - Allowing all origins');
    corsOptions = {
        origin: true, // Reflect the request origin
        credentials: true,
        methods: ['GET', 'POST']
    };
}

const io = socketIo(server, {
    cors: corsOptions,
    transports: ['websocket', 'polling']
});

// ===== SOCKET.IO AUTHENTICATION =====
io.use((socket, next) => {
    console.log('🔍 Socket connection attempt from:', socket.handshake.headers.origin);

    // Check if we have user data passed in auth (from frontend)
    const authData = socket.handshake.auth;
    if (authData && authData.userId && authData.userId !== '') {
        console.log(` Using auth data: ${authData.username} (${authData.userId})`);
        socket.userId = authData.userId;
        socket.username = authData.username || 'User';
        socket.role = authData.role || 'user';
        return next();
    }

    // Try to get session from cookies
    const cookies = socket.handshake.headers.cookie;
    if (!cookies) {
        console.log(' No cookies found - anonymous connection');
        socket.userId = 'anonymous';
        socket.username = 'Anonymous';
        socket.role = 'guest';
        return next();
    }

    const sessionCookie = cookies.match(/connect\.sid=([^;]+)/)?.[1];
    if (!sessionCookie) {
        console.log(' No session cookie found');
        socket.userId = 'anonymous';
        socket.username = 'Anonymous';
        socket.role = 'guest';
        return next();
    }

    console.log(' Found session cookie, attempting authentication...');

    // Use session middleware to restore session
    sessionMiddleware(socket.request, {}, (err) => {
        if (err) {
            console.error('Session middleware error:', err);
            socket.userId = 'anonymous';
            socket.username = 'Anonymous';
            socket.role = 'guest';
            return next();
        }

        // Check if user is authenticated in session
        if (socket.request.session && socket.request.session.passport) {
            const userId = socket.request.session.passport.user;
            console.log(' Found user ID in session:', userId);

            const User = require('./models/User');
            User.getById(userId)
                .then(user => {
                    if (user) {
                        socket.userId = user.id;
                        socket.username = user.username || 'Anonymous';
                        socket.role = user.role || 'user';
                        socket.user = user;
                        console.log(` Socket authenticated: ${socket.username} (${user.id})`);
                    } else {
                        console.log(' User not found in database');
                        socket.userId = 'anonymous';
                        socket.username = 'Anonymous';
                        socket.role = 'guest';
                    }
                    next();
                })
                .catch(err => {
                    console.error('User fetch error:', err);
                    socket.userId = 'anonymous';
                    socket.username = 'Anonymous';
                    socket.role = 'guest';
                    next();
                });
        } else {
            console.log(' No passport found in session');
            socket.userId = 'anonymous';
            socket.username = 'Anonymous';
            socket.role = 'guest';
            next();
        }
    });
});

// ===== SOCKET.IO EVENT HANDLERS =====
io.on('connection', (socket) => {

    // Join appropriate rooms
    if (socket.userId !== 'anonymous') {
        socket.join(`user:${socket.userId}`);

        if (socket.role === 'admin') {
            socket.join('admin-room');
            // Broadcast admin online status
            socket.broadcast.emit('admin-status', {
                status: 'online',
                username: socket.username
            });

            // Send initial conversations to admin
            sendAdminConversations(socket);
        } else {
            // Notify admins about user online status
            io.to('admin-room').emit('user-status', {
                userId: socket.userId,
                username: socket.username,
                status: 'online'
            });
        }

        // Send connection confirmation with user data
        socket.emit('connected', {
            userId: socket.userId,
            role: socket.role,
            username: socket.username,
            authenticated: true
        });
    } else {
        // Send basic connection confirmation for anonymous
        socket.emit('connected', {
            userId: 'anonymous',
            role: 'guest',
            username: 'Anonymous',
            authenticated: false
        });
    }

    // ===== MESSAGE SENDING =====

    socket.on('send-message', async (data) => {
        try {
            const { content, targetUserId, optimisticId } = data;
            // ... validation ...

            let result;
            if (socket.role === 'admin') {
                result = await chatServices.sendAdminMessage(socket.userId, targetUserId, content);
            } else {
                result = await chatServices.sendMessage(socket.userId, content);
            }

            if (!result.success) {
                return socket.emit('error', { message: result.error });
            }

            const message = result.message;
            const messageData = {
                id: message.id,
                user_id: socket.role === 'admin' ? targetUserId : socket.userId,
                content: message.content,
                is_from_admin: socket.role === 'admin',
                username: socket.role === 'admin' ? 'Admin' : socket.username,
                created_at: message.created_at,
                is_read: false
            };

            if (socket.role === 'admin') {
                io.to(`user:${targetUserId}`).emit('new-message', messageData);
                // Send back to admin with optimisticId
                socket.emit('new-message', {
                    ...messageData,
                    username: 'You',
                    optimisticId: optimisticId // CRITICAL: Send back the optimisticId
                });
                updateAdminInboxForNewMessage(messageData, true);
            } else {
                io.to('admin-room').emit('new-message', {
                    ...messageData,
                    username: socket.username,
                    is_from_admin: false
                });
                // Send back to user with optimisticId
                socket.emit('new-message', {
                    ...messageData,
                    username: 'You',
                    is_from_admin: false,
                    optimisticId: optimisticId // CRITICAL: Send back the optimisticId
                });
                updateAdminInboxForNewMessage(messageData, false);
            }
        } catch (error) {
            console.error('Message send error:', error);
            socket.emit('error', { message: 'Failed to send message: ' + error.message });
        }
    });

    // Delete message event
    socket.on('delete-message', async (data) => {
        try {
            const { messageId } = data;

            // Check if user is authorized to delete
            const isAdmin = socket.role === 'admin';
            const userId = socket.userId;

            if (!userId || userId === 'anonymous') {
                return socket.emit('error', { message: 'Please login to delete messages' });
            }

            const result = await chatServices.deleteMessage(messageId, userId, isAdmin);

            if (result.success) {
                // Get the message details to notify the correct user
                const pool = require('./config/db');
                const msgRes = await pool.query(
                    'SELECT user_id FROM messages WHERE id = $1',
                    [messageId]
                );

                if (msgRes.rows.length > 0) {
                    const targetUserId = msgRes.rows[0].user_id;

                    // Notify all relevant clients
                    io.to(`user:${targetUserId}`).emit('message-deleted', {
                        messageId: messageId,
                        userId: targetUserId
                    });

                    // Also notify admin room if admin deleted it
                    if (isAdmin) {
                        io.to('admin-room').emit('message-deleted', {
                            messageId: messageId,
                            userId: targetUserId
                        });
                    }
                }

                socket.emit('message-deleted', {
                    messageId: messageId,
                    userId: userId
                });
            } else {
                socket.emit('error', { message: result.error || 'Failed to delete message' });
            }
        } catch (error) {
            console.error('Delete message error:', error);
            socket.emit('error', { message: 'Failed to delete message' });
        }
    });


    // Mark message as read
    socket.on('mark-message-read', async (data) => {
        try {
            const { messageId } = data;

            // Use the existing markAsRead method
            const result = await chatServices.markMessageAsRead(messageId);

            if (result.success) {
                const message = result.message;

                // Get the message to find the user
                const pool = require('./config/db');
                const msgRes = await pool.query(
                    'SELECT user_id FROM messages WHERE id = $1',
                    [messageId]
                );

                if (msgRes.rows.length > 0) {
                    const userId = msgRes.rows[0].user_id;

                    // Notify the user that their message was read
                    io.to(`user:${userId}`).emit('message-read', {
                        messageId: messageId,
                        readAt: message.read_at || new Date().toISOString()
                    });

                    // Also notify admin room
                    io.to('admin-room').emit('message-read', {
                        messageId: messageId,
                        readAt: message.read_at || new Date().toISOString()
                    });
                }

                console.log(` Message ${messageId} marked as read`);
            } else {
                console.error(` Failed to mark message ${messageId} as read:`, result.error);
            }
        } catch (error) {
            console.error('Mark message read error:', error);
            socket.emit('error', { message: 'Failed to mark message as read' });
        }
    });

    // Admin marks all messages from a user as read
    socket.on('mark-all-read', async (data) => {
        try {
            const { userId } = data;

            // Mark all messages from this user as read
            const result = await chatServices.markAllAsRead(userId);

            if (result.success) {
                console.log(` All messages from user ${userId} marked as read by admin`);

                // Notify the user that their messages were read
                io.to(`user:${userId}`).emit('all-messages-read', {
                    userId: userId,
                    timestamp: new Date().toISOString()
                });

                // Notify admin room
                io.to('admin-room').emit('all-messages-read', {
                    userId: userId,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error('Mark all read error:', error);
        }
    });

    // Message vanished
    socket.on('message-vanished', async (data) => {
        try {
            const { messageId } = data;

            // Mark as vanished in database
            await chatServices.markMessageAsVanished(messageId);

            // Notify all clients in the conversation
            const pool = require('./config/db');
            const msgRes = await pool.query(
                'SELECT user_id FROM messages WHERE id = $1',
                [messageId]
            );

            if (msgRes.rows.length > 0) {
                const userId = msgRes.rows[0].user_id;
                io.to(`user:${userId}`).emit('message-vanished', {
                    messageId: messageId
                });
                io.to('admin-room').emit('message-vanished', {
                    messageId: messageId
                });
            }
        } catch (error) {
            console.error('Message vanished error:', error);
        }
    });

    // ===== ADMIN INBOX REQUESTS =====
    socket.on('admin-get-conversations', async () => {
        if (socket.role === 'admin') {
            await sendAdminConversations(socket);
        }
    });

    // ===== TYPING INDICATOR =====
    socket.on('typing', (data) => {
        const { targetUserId, isTyping, userId } = data;

        if (socket.role === 'admin' && targetUserId) {
            // Admin typing to user
            io.to(`user:${targetUserId}`).emit('typing', {
                userId: 'admin',
                targetUserId: targetUserId,
                isTyping: isTyping,
                username: 'Admin'
            });
        } else if (socket.role === 'user') {
            // User typing to admin
            io.to('admin-room').emit('typing', {
                userId: socket.userId,
                targetUserId: 'admin',
                isTyping: isTyping,
                username: socket.username
            });
        }
    });
    // In app.js - Update the socket event handler

    // Message vanished - update database
    socket.on('message-vanished', async (data) => {
        try {
            const { messageId } = data;

            // Mark as vanished in database
            const result = await chatServices.markMessageAsVanished(messageId);

            if (result.success) {
                console.log(` Message ${messageId} marked as vanished in database`);

                // Notify all clients in the conversation
                const pool = require('./config/db');
                const msgRes = await pool.query(
                    'SELECT user_id FROM messages WHERE id = $1',
                    [messageId]
                );

                if (msgRes.rows.length > 0) {
                    const userId = msgRes.rows[0].user_id;
                    io.to(`user:${userId}`).emit('message-vanished', {
                        messageId: messageId
                    });
                    io.to('admin-room').emit('message-vanished', {
                        messageId: messageId
                    });
                }
            } else {
                console.error(` Failed to mark message ${messageId} as vanished:`, result.error);
            }
        } catch (error) {
            console.error('Message vanished error:', error);
        }
    });

    // Also add periodic cleanup for expired messages
    const MESSAGE_EXPIRY_HOURS = 24; // Or whatever you want
    const MESSAGE_CLEANUP_INTERVAL = 60 * 60 * 1000; // Every hour

    async function cleanupExpiredMessages() {
        try {
            const expiryDate = new Date(Date.now() - (MESSAGE_EXPIRY_HOURS * 60 * 60 * 1000));
            console.log(`🧹 Cleaning up messages older than: ${expiryDate.toISOString()}`);

            const result = await chatServices.deleteExpiredMessages(expiryDate);

            if (result.success && result.deletedCount > 0) {
                console.log(`🧹 Cleaned up ${result.deletedCount} expired messages`);

                // Notify all clients about expired messages
                io.emit('messages-expired', {
                    timestamp: new Date().toISOString(),
                    count: result.deletedCount
                });
            }
        } catch (error) {
            console.error('Error cleaning up expired messages:', error);
        }
    }

    // Run cleanup every hour
    setInterval(cleanupExpiredMessages, MESSAGE_CLEANUP_INTERVAL);

    // Also run on startup
    setTimeout(cleanupExpiredMessages, 5000);
    // ===== MARK AS READ =====
    socket.on('mark-as-read', async (data) => {
        try {
            const { messageId } = data;

            // Only admin can mark messages as read
            if (socket.role !== 'admin') {
                return socket.emit('error', { message: 'Unauthorized' });
            }

            // Update in database
            const chatServices = require('./services/chatServices');
            await chatServices.markMessageAsRead(messageId);

            // Notify sender that their message was read
            socket.emit('message-read', { messageId });

            console.log(`✓ Message ${messageId} marked as read by admin ${socket.username}`);

        } catch (error) {
            console.error('Mark as read error:', error);
            socket.emit('error', { message: 'Failed to mark as read' });
        }
    });

    // ===== ONLINE STATUS =====
    socket.on('set-online-status', (status) => {
        if (socket.role === 'user') {
            io.to('admin-room').emit('user-status', {
                userId: socket.userId,
                username: socket.username,
                status: status
            });
        } else if (socket.role === 'admin') {
            io.emit('admin-status', {
                status: status,
                username: socket.username
            });
        }
    });

    // ===== DISCONNECTION =====
    socket.on('disconnect', () => {
        console.log(` ${socket.username} disconnected`);

        // Notify others
        if (socket.role === 'user') {
            io.to('admin-room').emit('user-status', {
                userId: socket.userId,
                username: socket.username,
                status: 'offline'
            });
        } else if (socket.role === 'admin') {
            io.emit('admin-status', {
                status: 'offline',
                username: socket.username
            });
        }
    });

    // ===== ERROR HANDLING =====
    socket.on('error', (error) => {
        console.error(`Socket ${socket.id} error:`, error);
    });
});

// ===== HELPER FUNCTIONS =====

// Send conversations to admin
async function sendAdminConversations(socket) {
    try {
        const chatServices = require('./services/chatServices');
        const result = await chatServices.getAdminConversations();

        socket.emit('conversations-list', {
            success: true,
            conversations: result.messages || []
        });

    } catch (error) {
        console.error('Error sending conversations to admin:', error);
        socket.emit('conversations-list', {
            success: false,
            error: 'Failed to load conversations'
        });
    }
}

// Update admin inbox when new message arrives
async function updateAdminInboxForNewMessage(messageData, isFromAdmin) {
    try {
        // Get updated conversation data
        const conversationUpdate = {
            user_id: messageData.user_id,
            username: messageData.username || 'Anonymous User',
            last_message: messageData.content,
            last_message_at: messageData.created_at,
            unread_count: isFromAdmin ? 0 : 1 // If admin sent, no unread count
        };

        // Send to all admins
        io.to('admin-room').emit('conversation-updated', conversationUpdate);

    } catch (error) {
        console.error('Error updating admin inbox:', error);
    }
}

// Broadcast to all admin sockets
function broadcastToAdmins(event, data) {
    io.to('admin-room').emit(event, data);
}

const web = require('./router/web');
const api = require('./router/api');

app.use('/', web);
app.use('/api', api);

// Add API endpoint for polling fallback
app.get('/chat/api/messages', async (req, res) => {
    try {
        const lastUpdate = req.query.lastUpdate;
        const userId = req.user?.id;

        if (!userId) {
            return res.json({ messages: [] });
        }

        const chatServices = require('./services/chatServices');
        const result = await chatServices.getNewMessages(lastUpdate);

        if (result.success) {
            res.json({ messages: result.messages || [] });
        } else {
            res.json({ messages: [] });
        }
    } catch (error) {
        console.error('API messages error:', error);
        res.json({ messages: [] });
    }
});

// ===== ERROR HANDLING =====
// 404 Handler
app.use((req, res) => {
    let userActive = req.user ? true : false;
    res.render('404', {
        pageTitle: `404`,
        userActive
    });
});

// General error handling middleware
app.use((err, req, res, next) => {
    console.error(' Application Error:', err);
    res.redirect('/');
});

// ===== START SERVER =====
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Socket.IO ready`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Test Socket.IO: http://localhost:${PORT}/test-socket`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Debug info: http://localhost:${PORT}/debug`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = { app, server, io };