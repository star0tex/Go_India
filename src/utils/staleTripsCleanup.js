// src/utils/staleTripsCleanup.js
import Trip from '../models/Trip.js';
import User from '../models/User.js';

/**
 * Release trips that have been stuck without progress for too long
 * Runs every 2 minutes
 */
export const startStaleTripCleanup = () => {
  setInterval(async () => {
    try {
      const now = new Date();
      const fiveMinutesAgo = new Date(now - 5 * 60 * 1000);
      const twoMinutesAgo = new Date(now - 2 * 60 * 1000);

      // Find trips assigned to driver but no progress
      const staleTrips = await Trip.find({
        status: { $in: ['driver_assigned', 'ride_started'] },
        assignedDriver: { $exists: true, $ne: null },
        $or: [
          // No heartbeat received yet and accepted >5 mins ago
          {
            lastDriverHeartbeat: null,
            acceptedAt: { $lt: fiveMinutesAgo },
          },
          // Last heartbeat was >2 minutes ago
          {
            lastDriverHeartbeat: { $lt: twoMinutesAgo },
          },
        ],
      });

      if (staleTrips.length === 0) return;

      console.log(`🧹 Found ${staleTrips.length} stale trip(s) to release...`);

      for (const trip of staleTrips) {
        // Release the driver
        if (trip.assignedDriver) {
          await User.findByIdAndUpdate(trip.assignedDriver, {
            $set: {
              currentTripId: null,
              isBusy: false,
              canReceiveNewRequests: false,
            },
          });
          console.log(`✅ Released driver ${trip.assignedDriver} from stale trip ${trip._id}`);
        }

        // Mark trip as timeout
        await Trip.findByIdAndUpdate(trip._id, {
          $set: { status: 'timeout' },
          $unset: { assignedDriver: 1 },
        });

        console.log(`⏰ Trip ${trip._id} marked as stale and released`);
      }
    } catch (e) {
      console.error('❌ Stale trip cleanup error:', e);
    }
  }, 120000); // Every 2 minutes

  console.log('🧹 Stale trip cleanup job started (runs every 2 minutes)');
};