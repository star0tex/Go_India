// src/controllers/notificationController.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';
import { sendFCMToDriver, sendFCMToCustomer } from '../utils/fcmSender.js';

const sendTripNotification = async (to, type, tripId) => {
  try {
    const trip = await Trip.findById(tripId);
    if (!trip) return;

    if (to === 'driver') {
      const driver = await User.findById(trip.driver);
      if (!driver || !driver.fcmToken) return;

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
      const customer = await User.findById(trip.customer);
      if (!customer || !customer.fcmToken) return;

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
          driver: trip.driver,
        },
      });
    }
  } catch (err) {
    console.error(`❌ Error in sendTripNotification: ${err.message}`);
  }
};

const sendManualNotification = async (req, res) => {
  try {
    const { title, body, userType } = req.body;

    const filter = userType === 'driver'
      ? { isDriver: true, fcmToken: { $exists: true } }
      : { isDriver: false, fcmToken: { $exists: true } };

    const users = await User.find(filter);

    const sendTasks = users.map((user) =>
      user.isDriver
        ? sendFCMToDriver(user.fcmToken, { title, body, data: {} })
        : sendFCMToCustomer(user.fcmToken, { title, body, data: {} })
    );

    await Promise.all(sendTasks);

    res.status(200).json({ success: true, message: `Notification sent to ${users.length} ${userType}s.` });
  } catch (err) {
    console.error(`❌ Error in sendManualNotification: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to send notification.' });
  }
};

const sendReassignmentNotification = async (driverId, tripId) => {
  try {
    const driver = await User.findById(driverId);
    const trip = await Trip.findById(tripId);
    if (!driver || !trip || !driver.fcmToken) return;

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
