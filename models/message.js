const createTableIfNotExists = require('../utils/createTableIfNotExists');
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const User = require('./User');

class Message {
  static async init() {
    const Messages = `
    CREATE TABLE messages (
      id VARCHAR PRIMARY KEY,
      user_id VARCHAR REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      is_read BOOLEAN DEFAULT FALSE,
      is_deleted BOOLEAN DEFAULT FALSE,
      is_from_admin BOOLEAN DEFAULT FALSE,  -- NEW: Track if message is from admin
      read_at TIMESTAMP,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `;

    await createTableIfNotExists('messages', Messages);

    // Create necessary indexes
    try {
      await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_messages_is_read ON messages(is_read);
      CREATE INDEX IF NOT EXISTS idx_messages_is_from_admin ON messages(is_from_admin);
      CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `);
    } catch (error) {
      console.log('Index creation error:', error.message);
    }
  }

// Add to Message class in models/Message.js

// Mark message as read and return it with timestamp
static async markAsReadWithTimestamp(messageId) {
  try {
    const res = await pool.query(`
      UPDATE messages 
      SET is_read = true,
          read_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [messageId]);
    return res.rows[0];
  } catch (error) {
    console.log(`error marking message as read with timestamp: ${error.message}`);
    throw error;
  }
}

// Get messages that are read and should be vanished
static async getReadMessagesToVanish(userId, olderThanSeconds = 10) {
  try {
    const res = await pool.query(`
      SELECT 
        m.*,
        CASE 
          WHEN m.is_from_admin = true THEN 'Admin'
          ELSE COALESCE(u.username, 'You')
        END as username
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.user_id = $1 
        AND m.is_read = true 
        AND m.is_deleted = false
        AND m.status = 'pending'
        AND m.read_at < (CURRENT_TIMESTAMP - INTERVAL '10 seconds')
      ORDER BY m.created_at ASC
    `, [userId]);
    return res.rows;
  } catch (error) {
    console.log(`error getting read messages to vanish: ${error.message}`);
    return [];
  }
}

// Mark message as vanished (soft delete after being read)
static async markAsVanished(messageId) {
  try {
    const res = await pool.query(`
      UPDATE messages 
      SET is_deleted = true,
          deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [messageId]);
    return res.rows[0];
  } catch (error) {
    console.log(`error marking message as vanished: ${error.message}`);
    throw error;
  }
}

// Get messages excluding vanished ones
static async getActiveMessages(userId) {
  try {
    const res = await pool.query(`
      SELECT 
        m.*,
        CASE 
          WHEN m.is_from_admin = true THEN 'Admin'
          ELSE COALESCE(u.username, 'You')
        END as username
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.user_id = $1 
        AND m.status = 'pending'
        AND m.is_deleted = false
      ORDER BY m.created_at ASC
    `, [userId]);
    return res.rows;
  } catch (error) {
    console.log(`error getting active messages: ${error.message}`);
    return [];
  }
}

// Add to Message class in models/Message.js

// Mark message as vanished (soft delete)
static async markAsVanished(messageId) {
  try {
    const res = await pool.query(`
      UPDATE messages 
      SET is_deleted = true, 
          deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [messageId]);
    return res.rows[0];
  } catch (error) {
    console.log(`error marking message as vanished: ${error.message}`);
    throw error;
  }
}

// Delete expired messages
static async deleteExpiredMessages(expiryDate) {
  try {
    const res = await pool.query(`
      UPDATE messages 
      SET is_deleted = true, 
          deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE created_at < $1 
      AND is_deleted = false
      RETURNING *
    `, [expiryDate]);
    
    return {
      success: true,
      deletedCount: res.rowCount,
      messages: res.rows
    };
  } catch (error) {
    console.log(`error deleting expired messages: ${error.message}`);
    throw error;
  }
}

  // Admin sends message to user
  static async createAdminMessage(adminUserId, targetUserId, content) {
    try {
      const id = uuidv4();
      const res = await pool.query(`
      INSERT INTO messages (id, user_id, content, status, is_from_admin, created_at)
      VALUES ($1, $2, $3, 'pending', true, CURRENT_TIMESTAMP)
      RETURNING *
    `, [id, targetUserId, content]);
      return res.rows[0];
    } catch (error) {
      console.log(`error creating admin message: ${error.message}`);
      throw error;
    }
  }

  // Get conversation between user and admin
  static async getConversation(userId) {
    try {
      const res = await pool.query(`
      SELECT 
        m.*,
        CASE 
          WHEN m.is_from_admin = true THEN 'admin'
          ELSE COALESCE(u.username, 'You')
        END as username
        FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.user_id = $1
      ORDER BY m.created_at ASC
    `, [userId]);
      return res.rows;
    } catch (error) {
      console.log(`error getting conversation: ${error.message}`);
      return [];
    }
  }


  static async getConversations() {
    try {
      const res = await pool.query(`
        SELECT 
          u.id as user_id,
          u.username,
         
          u.created_at as user_created_at,
          COUNT(m.id) as message_count,
          SUM(CASE WHEN m.is_read = false THEN 1 ELSE 0 END) as unread_count,
          MAX(m.created_at) as last_message_at,
          (
            SELECT content 
            FROM messages m2 
            WHERE m2.user_id = u.id 
            ORDER BY m2.created_at DESC 
            LIMIT 1
          ) as last_message
        FROM users u
        JOIN messages m ON u.id = m.user_id
        WHERE m.status = 'pending'
        GROUP BY u.id, u.username, u.created_at
        ORDER BY last_message_at DESC
      `);
      return res.rows;
    } catch (error) {
      console.log(`error getting conversations: ${error.message}`);
      return [];
    }
  }

  // Get messages from a specific user (admin view)
  static async getMessagesFromUser(userId) {
    try {
      const res = await pool.query(`
        SELECT 
          m.*,
          COALESCE(u.username, 'Anonymous') as username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.user_id = $1 AND m.status = 'pending'
        ORDER BY m.created_at ASC
      `, [userId]);
      return res.rows;
    } catch (error) {
      console.log(`error getting messages from user: ${error.message}`);
      return [];
    }
  }

  // Get messages for regular users (their own messages)
  static async getUserMessages(userId) {
    try {
      const res = await pool.query(`
        SELECT 
          m.*,
          'You' as username
        FROM messages m
        WHERE m.user_id = $1 AND m.status = 'pending'
        ORDER BY m.created_at DESC
      `, [userId]);
      return res.rows;
    } catch (error) {
      console.log(`error getting user messages: ${error.message}`);
      return [];
    }
  }

  // Get unread messages count (for admin notification)
  static async getUnreadCount(userId = null) {
    try {
      let query = `SELECT COUNT(*) as count FROM messages WHERE status = 'pending' AND is_read = false`;
      const params = [];

      if (userId) {
        query += ` AND user_id = $1`;
        params.push(userId);
      }

      const res = await pool.query(query, params);
      return parseInt(res.rows[0].count);
    } catch (error) {
      console.log(`error getting unread count: ${error.message}`);
      return 0;
    }
  }

  // Create a new message (sent to admin)
  static async create(userId, content) {
    try {
      const id = uuidv4();
      const res = await pool.query(`
        INSERT INTO messages (id, user_id, content, status, created_at)
        VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)
        RETURNING *
      `, [id, userId, content]);
      return res.rows[0];
    } catch (error) {
      console.log(`error creating message: ${error.message}`);
      throw error;
    }
  }

  // Mark message as read (admin has read it)
  static async markAsRead(messageId) {
    try {
      const res = await pool.query(`
        UPDATE messages 
        SET is_read = true,
            read_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
        RETURNING *
      `, [messageId]);
      return res.rows[0];
    } catch (error) {
      console.log(`error marking message as read: ${error.message}`);
      throw error;
    }
  }

  // Mark all messages from a user as read
  static async markAllAsRead(userId) {
    try {
      const res = await pool.query(`
        UPDATE messages 
        SET is_read = true,
            read_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1 AND is_read = false
        RETURNING *
      `, [userId]);
      return res.rows;
    } catch (error) {
      console.log(`error marking all as read: ${error.message}`);
      throw error;
    }
  }

  // Delete message (admin can remove)
  static async deleteMessage(messageId) {
    try {
      const res = await pool.query(`
        DELETE FROM messages 
        WHERE id = $1
        RETURNING *
      `, [messageId]);
      return res.rows[0];
    } catch (error) {
      console.log(`error deleting message: ${error.message}`);
      throw error;
    }
  }

  // Get messages since a specific ID (for real-time updates)
  static async getMessagesSince(sinceId) {
    try {
      const res = await pool.query(`
        SELECT 
          m.*,
          COALESCE(u.username, 'Anonymous') as username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.id > $1 AND m.status = 'pending'
        ORDER BY m.created_at ASC
      `, [sinceId]);
      return res.rows;
    } catch (error) {
      console.log(`error getting messages since: ${error.message}`);
      return [];
    }
  }

  // Get all chat messages
  static async getChats() {
    try {
      const res = await pool.query(`
        SELECT 
          m.*,
          COALESCE(u.username, 'Anonymous') as username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.status = 'pending'
        ORDER BY m.created_at ASC
      `);
      return res.rows;
    } catch (error) {
      console.log(`error getting chats: ${error.message}`);
      return [];
    }
  }

  // Secure message creation with validation
  static async createSecure(userId, content) {
    try {
      // Validate input
      if (!userId || !content || !content.trim()) {
        throw new Error('Invalid input');
      }

      // Sanitize content (basic XSS protection)
      const sanitizedContent = content
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .trim()
        .substring(0, 500); // Limit length

      const id = uuidv4();
      const res = await pool.query(`
      INSERT INTO messages (id, user_id, content, status, created_at)
      VALUES ($1, $2, $3, 'pending', CURRENT_TIMESTAMP)
      RETURNING *
    `, [id, userId, sanitizedContent]);

      return res.rows[0];
    } catch (error) {
      console.log(`Secure message creation error: ${error.message}`);
      throw error;
    }
  }

  // Get messages with rate limiting check
  static async getMessagesWithRateLimit(userId, sinceId) {
    try {
      // Check rate limit (max 100 messages per minute)
      const rateLimit = await this.checkRateLimit(userId);
      if (!rateLimit.allowed) {
        throw new Error('Rate limit exceeded');
      }

      const res = await pool.query(`
      SELECT 
        m.*,
        CASE 
          WHEN m.is_from_admin = true THEN 'Admin'
          ELSE COALESCE(u.username, 'You')
        END as username
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.id > $1 
        AND m.user_id = $2
        AND m.status = 'pending'
      ORDER BY m.created_at ASC
    `, [sinceId, userId]);

      return res.rows;
    } catch (error) {
      console.log(`Rate limited message fetch error: ${error.message}`);
      return [];
    }
  }

  // Rate limiting helper
  static async checkRateLimit(userId) {
    try {
      const oneMinuteAgo = new Date(Date.now() - 60000);

      const res = await pool.query(`
      SELECT COUNT(*) as count 
      FROM messages 
      WHERE user_id = $1 
        AND created_at > $2
    `, [userId, oneMinuteAgo]);

      const count = parseInt(res.rows[0].count);
      const allowed = count < 100; // Max 100 messages per minute

      return {
        allowed,
        remaining: allowed ? 100 - count : 0,
        resetTime: new Date(Date.now() + 60000) // 1 minute from now
      };
    } catch (error) {
      console.log(`Rate limit check error: ${error.message}`);
      return { allowed: false, remaining: 0, resetTime: null };
    }
  }

  // Secure admin message creation
  static async createSecureAdminMessage(adminUserId, targetUserId, content) {
    try {
      // Verify admin has permission

      const isAdmin = await User.isAdmin(adminUserId);

      if (!isAdmin) {
        throw new Error('Unauthorized: Admin access required');
      }

      // Verify target user exists
      const targetUser = await User.getById(targetUserId);
      if (!targetUser) {
        throw new Error('Target user not found');
      }

      // Sanitize content
      const sanitizedContent = content
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .trim()
        .substring(0, 500);

      const id = uuidv4();
      const res = await pool.query(`
      INSERT INTO messages (id, user_id, content, status, is_from_admin, created_at)
      VALUES ($1, $2, $3, 'pending', true, CURRENT_TIMESTAMP)
      RETURNING *
    `, [id, targetUserId, sanitizedContent]);

      return res.rows[0];
    } catch (error) {
      console.log(`Secure admin message error: ${error.message}`);
      throw error;
    }
  }


  // Get conversations for admin inbox
  static async getAdminConversations(lastUpdate = null) {
    try {


      let query = `
                SELECT 
                    u.id as user_id,
                    u.username,
                    u.created_at as user_created_at,
                    COUNT(m.id) as message_count,
                    SUM(CASE WHEN m.is_read = false AND m.is_from_admin = false THEN 1 ELSE 0 END) as unread_count,
                    MAX(m.created_at) as last_message_at,
                    (
                        SELECT content 
                        FROM messages m2 
                        WHERE m2.user_id = u.id 
                        ORDER BY m2.created_at DESC 
                        LIMIT 1
                    ) as last_message
                FROM users u
                LEFT JOIN messages m ON m.user_id = u.id
                WHERE u.role = 'user'
                GROUP BY u.id, u.username, u.created_at
                HAVING COUNT(m.id) > 0
            `;

      const params = [];

      if (lastUpdate) {
        query += ` AND MAX(m.created_at) > $1`;
        params.push(lastUpdate);
      }

      query += ` ORDER BY MAX(m.created_at) DESC`;

      const result = await pool.query(query, params);
      return result.rows;
    } catch (error) {
      console.error('Error getting admin conversations:', error);
      return [];
    }
  }

  // Add to Message class in models/Message.js

// Soft delete a message (mark as deleted)
static async softDeleteMessage(messageId, userId, isAdmin = false) {
  try {
    // First check if user owns this message or is admin
    const checkRes = await pool.query(`
      SELECT user_id, is_from_admin FROM messages WHERE id = $1
    `, [messageId]);
    
    if (checkRes.rows.length === 0) {
      return { success: false, error: 'Message not found' };
    }
    
    const message = checkRes.rows[0];
    
    // Check permissions
    if (!isAdmin && message.user_id !== userId) {
      return { success: false, error: 'Unauthorized to delete this message' };
    }
    
    // Soft delete
    const res = await pool.query(`
      UPDATE messages 
      SET is_deleted = true, 
          deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [messageId]);
    
    return { 
      success: true, 
      message: res.rows[0] 
    };
  } catch (error) {
    console.log(`error soft deleting message: ${error.message}`);
    throw error;
  }
}

// Delete expired messages
static async deleteExpiredMessages(expiryDate) {
  try {
    const res = await pool.query(`
      UPDATE messages 
      SET is_deleted = true, 
          deleted_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE created_at < $1 
      AND is_deleted = false
      RETURNING *
    `, [expiryDate]);
    
    return {
      success: true,
      deletedCount: res.rowCount,
      messages: res.rows
    };
  } catch (error) {
    console.log(`error deleting expired messages: ${error.message}`);
    throw error;
  }
}

// Get messages excluding deleted ones
static async getMessagesExcludingDeleted(userId) {
  try {
    const res = await pool.query(`
      SELECT 
        m.*,
        CASE 
          WHEN m.is_from_admin = true THEN 'Admin'
          ELSE COALESCE(u.username, 'You')
        END as username
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.user_id = $1 
        AND m.status = 'pending'
        AND m.is_deleted = false
      ORDER BY m.created_at ASC
    `, [userId]);
    return res.rows;
  } catch (error) {
    console.log(`error getting messages excluding deleted: ${error.message}`);
    return [];
  }
}

// Get conversation excluding deleted messages
static async getConversationExcludingDeleted(userId) {
  try {
    const res = await pool.query(`
      SELECT 
        m.*,
        CASE 
          WHEN m.is_from_admin = true THEN 'admin'
          ELSE COALESCE(u.username, 'You')
        END as username
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.user_id = $1 
        AND m.is_deleted = false
      ORDER BY m.created_at ASC
    `, [userId]);
    return res.rows;
  } catch (error) {
    console.log(`error getting conversation excluding deleted: ${error.message}`);
    return [];
  }
}

}

module.exports = Message;