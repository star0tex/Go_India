// src/utils/fcmSender.js

import admin from 'firebase-admin';
import User from '../models/User.js';

/**
 * Sends a push notification using FCM.
 * @param {string} token - FCM device token.
 * @param {string} title - Notification title.
 * @param {string} body - Notification body.
 * @param {Object} data - Optional custom data payload.
 */
const sendPushNotification = async (token, title, body, data = {}) => {
  try {
    const message = {
      notification: { title, body },
      token,
      data,
    };

    const response = await admin.messaging().send(message);
    console.log('✅ FCM sent successfully:', response);
  } catch (error) {
    console.error('❌ FCM send error:', error.message);
  }
};

/**
 * Send notification to driver
 * @param {string} fcmToken
 * @param {string} title
 * @param {string} body
 * @param {Object} data
 */
export const sendToDriver = async (fcmToken, payload = {}, opts = {}) => {
  if (!fcmToken) return { success: false, reason: 'no_token' };

  const message = {
    token: fcmToken,
    data: payload.data || {},
    notification: payload.notification || undefined,
    android: payload.android,
    apns: payload.apns,
    webpush: payload.webpush,
    ...opts
  };

  try {
    const response = await admin.messaging().send(message);
    console.log('✅ FCM sent successfully:', response);
    return { success: true, response };
  } catch (err) {
    // Detailed logging
    console.error('❌ FCM send error:', err?.code || err?.message || err);

    const code = err?.code || '';
    const msg = String(err?.message || '');

    // Treat token-not-registered / requested entity not found as invalid token
    const isInvalidToken =
      code === 'messaging/registration-token-not-registered' ||
      msg.includes('Requested entity was not found') ||
      msg.includes('Invalid registration token') ||
      msg.includes('registration token is not a valid FCM token');

    if (isInvalidToken) {
      try {
        // best-effort: remove/clear token for any user that has this token
        const user = await User.findOne({ fcmToken }).select('_id phone');
        if (user) {
          await User.updateOne({ _id: user._id }, { $unset: { fcmToken: 1 } });
          console.log(`ℹ️ Cleared invalid fcmToken for user ${user._id} (${user.phone || 'unknown'})`);
        } else {
          console.log('ℹ️ Invalid token not found in users collection, skipping cleanup.');
        }
      } catch (cleanupErr) {
        console.warn('⚠️ Failed to cleanup invalid fcmToken:', cleanupErr);
      }
      return { success: false, reason: 'invalid_token', error: err };
    }

    // For other errors return details for retry/backoff
    return { success: false, reason: 'other_error', error: err };
  }
};

/**
 * Send notification to customer
 * @param {string} fcmToken
 * @param {string} title
 * @param {string} body
 * @param {Object} data
 */
export const sendToCustomer = async (fcmToken, title, body, data = {}) => {
  await sendPushNotification(fcmToken, title, body, { type: 'customer', ...data });
};
