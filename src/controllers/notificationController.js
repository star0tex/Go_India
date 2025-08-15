// src/controllers/notificationController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { sendFCMToDriver, sendFCMToCustomer } from '../utils/fcmSender.js';

/**
 * Sends trip-related push notifications.
 * @param {'driver'|'customer'} to - Who to send the notification to.
 * @param {string} type - The notification type.
 * @param {string} tripId - The ID of the trip.
 */
const sendTripNotification = async (to, type, tripId) => {
  try {
    const trip = await Trip.findById(tripId);
    if (!trip) {
      console.warn(`⚠️ Trip ${tripId} not found`);
      return;
    }

    if (to === 'driver') {
      const driver = await User.findById(trip.assignedDriver);
      if (!driver || !driver.fcmToken) {
        console.warn(`⚠️ No FCM token for driver on trip ${tripId}`);
        return;
      }

      let title = '';
      let body = '';

      if (type === 'new_request') {
        title = 'New Trip Request';
        body = 'You have a new trip request.';
      } else if (type === 'reassigned') {
        title = 'New Trip Assigned';
        body = 'You have been reassigned to a trip.';
      }

      await sendFCMToDriver(driver.fcmToken, {
        title,
        body,
        data: {
          tripId: trip._id.toString(),
          pickup: trip.pickup,
          drop: trip.drop,
          vehicleType: trip.vehicleType,
          type: trip.type,
        },
      });
    }

    if (to === 'customer') {
      const customer = await User.findById(trip.customerId);
      if (!customer || !customer.fcmToken) {
        console.warn(`⚠️ No FCM token for customer on trip ${tripId}`);
        return;
      }

      let title = '';
      let body = '';

      if (type === 'accepted') {
        title = 'Driver Confirmed';
        body = 'Your driver has accepted the trip.';
      } else if (type === 'cancelled') {
        title = 'Trip Cancelled';
        body = 'Your trip has been cancelled.';
      }

      await sendFCMToCustomer(customer.fcmToken, {
        title,
        body,
        data: {
          tripId: trip._id.toString(),
          driver: trip.assignedDriver,
        },
      });
    }
  } catch (err) {
    console.error(`❌ Error in sendTripNotification: ${err.message}`);
  }
};

/**
 * Sends a manual notification to all drivers or customers.
 */
const sendManualNotification = async (req, res) => {
  try {
    const { title, body, userType } = req.body;

    const filter =
      userType === 'driver'
        ? { isDriver: true, fcmToken: { $exists: true, $ne: null } }
        : { isDriver: false, fcmToken: { $exists: true, $ne: null } };

    const users = await User.find(filter);

    const sendTasks = users.map((user) =>
      user.isDriver
        ? sendFCMToDriver(user.fcmToken, { title, body, data: {} })
        : sendFCMToCustomer(user.fcmToken, { title, body, data: {} })
    );

    await Promise.all(sendTasks);

    res.status(200).json({
      success: true,
      message: `Notification sent to ${users.length} ${userType}s.`,
    });
  } catch (err) {
    console.error(`❌ Error in sendManualNotification: ${err.message}`);
    res
      .status(500)
      .json({ success: false, message: 'Failed to send notification.' });
  }
};

/**
 * Sends a notification to a driver when they are reassigned to a trip.
 */
const sendReassignmentNotification = async (driverId, tripId) => {
  try {
    const driver = await User.findById(driverId);
    const trip = await Trip.findById(tripId);
    if (!driver || !trip || !driver.fcmToken) {
      console.warn(
        `⚠️ Cannot send reassignment notification: missing driver/trip/token`
      );
      return;
    }

    await sendFCMToDriver(driver.fcmToken, {
      title: 'Trip Reassignment',
      body: 'You’ve been reassigned to a trip. Please check.',
      data: {
        tripId: trip._id.toString(),
        pickup: trip.pickup,
        drop: trip.drop,
        vehicleType: trip.vehicleType,
        type: trip.type,
      },
    });

    console.log(`📲 Reassignment notification sent to driver ${driverId}`);
  } catch (err) {
    console.error(`❌ Error in sendReassignmentNotification: ${err.message}`);
  }
};

export {
  sendTripNotification,
  sendManualNotification,
  sendReassignmentNotification,
};
