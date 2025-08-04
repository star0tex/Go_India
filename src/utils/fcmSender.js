// src/utils/fcmSender.js

import admin from './firebase.js'; // Make sure firebase.js exports initialized admin

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
export const sendToDriver = async (fcmToken, title, body, data = {}) => {
  await sendPushNotification(fcmToken, title, body, { type: 'driver', ...data });
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
