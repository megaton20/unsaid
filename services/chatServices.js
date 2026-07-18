const Message = require('../models/message');
const User = require('../models/User');

class chatServices {
  // Get messages for regular users (their own messages)
  static async getUserMessages(userId) {
    try {
      const messages = await Message.getUserMessages(userId);
      
      return {
        success: true,
        messages: messages || []
      };
    } catch (error) {
      console.error('Get user messages service error:', error);
      return {
        success: false,
        error: 'Failed to load your messages',
        statusCode: 500
      };
    }
  }

  // Get all conversations for admin inbox
  static async getConversations() {
    try {
      const conversations = await Message.getConversations();
      const totalMessages = conversations.reduce((sum, conv) => sum + parseInt(conv.message_count), 0);
      const unreadCount = conversations.reduce((sum, conv) => sum + parseInt(conv.unread_count), 0);
      
      return {
        success: true,
        conversations: conversations || [],
        totalMessages: totalMessages,
        unreadCount: unreadCount
      };
    } catch (error) {
      console.error('Conversations service error:', error);
      return {
        success: false,
        error: 'Failed to load conversations',
        statusCode: 500
      };
    }
  }

  // Get messages from a specific user (for admin)
  static async getMessagesFromUser(userId) {
    try {
      const messages = await Message.getMessagesFromUser(userId);
      const user = await User.getById(userId);
      const unreadCount = await Message.getUnreadCount(userId);
      
      return {
        success: true,
        messages: messages || [],
        user: user || null,
        unreadCount: unreadCount
      };
    } catch (error) {
      console.error('User messages service error:', error);
      return {
        success: false,
        error: 'Failed to load user messages',
        statusCode: 500
      };
    }
  }

  // Send message (always goes to admin)
  static async sendMessage(userId, content) {
    try {
      const message = await Message.create(userId, content);
      
      return {
        success: true,
        message: {
          ...message,
          username: 'You'
        }
      };
    } catch (error) {
      console.error('message service error:', error);
      return {
        success: false,
        error: 'Failed to send message',
        statusCode: 500
      };
    }
  }

  // Admin: Mark message as read
  static async markMessageAsRead(messageId) {
    try {
      const message = await Message.markAsRead(messageId);
      
      return {
        success: true,
        message: message
      };
    } catch (error) {
      console.error('Mark as read service error:', error);
      return {
        success: false,
        error: 'Failed to mark message as read',
        statusCode: 500
      };
    }
  }

  // Admin: Mark all messages from user as read
  static async markAllAsRead(userId) {
    try {
      const messages = await Message.markAllAsRead(userId);
      
      return {
        success: true,
        messages: messages
      };
    } catch (error) {
      console.error('Mark all as read service error:', error);
      return {
        success: false,
        error: 'Failed to mark messages as read',
        statusCode: 500
      };
    }
  }

  // Soft delete message (user can delete own, admin can delete any)
  static async deleteMessage(messageId, userId, isAdmin = false) {
    try {
      const result = await Message.softDeleteMessage(messageId, userId, isAdmin);
      
      return {
        success: result.success,
        message: result.message,
        error: result.error
      };
    } catch (error) {
      console.error('Delete message service error:', error);
      return {
        success: false,
        error: 'Failed to delete message',
        statusCode: 500
      };
    }
  }

  // Mark message as vanished (soft delete)
  static async markMessageAsVanished(messageId) {
    try {
      const message = await Message.markAsVanished(messageId);
      
      return {
        success: true,
        message: message
      };
    } catch (error) {
      console.error('Mark message as vanished service error:', error);
      return {
        success: false,
        error: 'Failed to mark message as vanished',
        statusCode: 500
      };
    }
  }

  // Delete expired messages
  static async deleteExpiredMessages(expiryDate) {
    try {
      const result = await Message.deleteExpiredMessages(expiryDate);
      
      return {
        success: true,
        deletedCount: result.deletedCount,
        messages: result.messages
      };
    } catch (error) {
      console.error('Delete expired messages service error:', error);
      return {
        success: false,
        error: 'Failed to delete expired messages',
        statusCode: 500
      };
    }
  }

  // Get new messages since last ID (for real-time)
  static async getNewMessages(sinceId, userId = null) {
    try {
      let query = `
        SELECT 
          m.*,
          CASE 
            WHEN m.is_from_admin = true THEN 'Admin'
            ELSE COALESCE(u.username, 'You')
          END as username
        FROM messages m
        LEFT JOIN users u ON m.user_id = u.id
        WHERE m.id > $1 
          AND m.status = 'pending'
          AND m.is_deleted = false
      `;
      
      const params = [sinceId];
      
      if (userId) {
        query += ` AND m.user_id = $2`;
        params.push(userId);
      }
      
      query += ` ORDER BY m.created_at ASC`;
      
      const pool = require('../config/db');
      const res = await pool.query(query, params);
      return res.rows;
    } catch (error) {
      console.log(`error getting messages since: ${error.message}`);
      return [];
    }
  }

  // Get conversation updates for admin (real-time)
  static async getConversationUpdates(lastUpdate) {
    try {
      const conversations = await Message.getConversations();
      
      // Filter for new conversations since last update
      const newConversations = conversations.filter(conv => 
        new Date(conv.last_message_at) > new Date(lastUpdate)
      );

      const unreadCount = conversations.reduce((sum, conv) => sum + parseInt(conv.unread_count), 0);
      
      return {
        success: true,
        newConversations: newConversations,
        unreadCount: unreadCount
      };
    } catch (error) {
      console.error('Conversation updates service error:', error);
      return {
        success: false,
        error: 'Failed to get updates',
        statusCode: 500
      };
    }
  }

  // Admin sends message to user
  static async sendAdminMessage(adminUserId, targetUserId, content) {
    try {
      const message = await Message.createAdminMessage(adminUserId, targetUserId, content);
      
      return {
        success: true,
        message: {
          ...message,
          username: 'Admin'
        }
      };
    } catch (error) {
      console.error('admin message service error:', error);
      return {
        success: false,
        error: 'Failed to send message',
        statusCode: 500
      };
    }
  }

  // Get conversation for user (includes both user and admin messages)
  static async getConversation(userId) {
    try {
      const messages = await Message.getConversationExcludingDeleted(userId);
      
      return {
        success: true,
        messages: messages || []
      };
    } catch (error) {
      console.error('conversation service error:', error);
      return {
        success: false,
        error: 'Failed to load conversation',
        statusCode: 500
      };
    }
  }

  // Get admin conversations
  static async getAdminConversations() {
    try {
      const messages = await Message.getAdminConversations();
      
      return {
        status: true,
        messages: messages || []
      };
    } catch (error) {
      console.error('conversation service error:', error);
      return {
        success: false,
        error: 'Failed to load conversation',
        statusCode: 500
      };
    }
  }

  // Add these methods to chatServices.js

// Mark message as read (using existing method)
static async markMessageAsRead(messageId) {
    try {
        const message = await Message.markAsRead(messageId);
        
        return {
            success: true,
            message: message
        };
    } catch (error) {
        console.error('Mark as read service error:', error);
        return {
            success: false,
            error: 'Failed to mark message as read',
            statusCode: 500
        };
    }
}

// Mark all messages from user as read
static async markAllAsRead(userId) {
    try {
        const messages = await Message.markAllAsRead(userId);
        
        return {
            success: true,
            messages: messages
        };
    } catch (error) {
        console.error('Mark all as read service error:', error);
        return {
            success: false,
            error: 'Failed to mark messages as read',
            statusCode: 500
        };
    }
}

// Mark message as vanished
static async markMessageAsVanished(messageId) {
    try {
        const message = await Message.markAsVanished(messageId);
        
        return {
            success: true,
            message: message
        };
    } catch (error) {
        console.error('Mark message as vanished service error:', error);
        return {
            success: false,
            error: 'Failed to mark message as vanished',
            statusCode: 500
        };
    }
}
}

module.exports = chatServices;