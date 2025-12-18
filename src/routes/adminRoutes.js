import express from "express";
import { verifyAdminToken } from "../middlewares/adminAuth.js";
import { protect } from "../middlewares/authMiddleware.js"; // 🔑 USER AUTH (driver/customer)

import {
  // Dashboard
  getDashboardStats,

  // Auth
  adminLogin,

  // Trips
  manualAssignDriver,
  getTripDetails,
  getAllTrips,
  markTripCompleted,
  cancelTrip,

  // Users
  getAllDrivers,
  getAllCustomers,
  blockCustomer,
  unblockCustomer,
  blockDriver,
  unblockDriver,

  // Push Notification
  sendPushToUsers,
  sendPushToIndividual,

  // Notifications
  getUserNotifications,
  markNotificationAsRead,
  markAllNotificationsAsRead,
  deleteNotification,

  // Fare Rates
  getAllFareRates,
  updateFareRate,
  createFareRate,
  deleteFareRate,

  // Documents
  getDriverDocuments,
  verifyDriverDocument,
  getPendingDocuments,
  getDocumentById,
  deleteDriverDocumentImage,
<<<<<<< HEAD

  // 🧪 TEST
=======
  
  // 🧪 TEST - Add this import
>>>>>>> 6049df7ec5642d30643132f7ca7502dee8f10538
  testImageAccess,
} from "../controllers/adminController.js";

const router = express.Router();

// =====================================================
// 🧪 TEST ENDPOINTS
// =====================================================
router.get("/test-images", testImageAccess);

// =====================================================
// 🟡 ADMIN AUTH
// =====================================================
router.post("/login", adminLogin);

// =====================================================
// 🟢 DASHBOARD
// =====================================================
router.get("/stats", verifyAdminToken, getDashboardStats);

// =====================================================
// 💰 FARE RATES
// =====================================================
router.get("/fare/rates", verifyAdminToken, getAllFareRates);
router.put("/fare/update/:id", verifyAdminToken, updateFareRate);
router.post("/fare/create", verifyAdminToken, createFareRate);
router.delete("/fare/delete/:id", verifyAdminToken, deleteFareRate);

// =====================================================
// 🧑 CUSTOMERS
// =====================================================
router.get("/customers", verifyAdminToken, getAllCustomers);
router.put("/customer/block/:customerId", verifyAdminToken, blockCustomer);
router.put("/customer/unblock/:customerId", verifyAdminToken, unblockCustomer);

// =====================================================
// 🚖 DRIVERS
// =====================================================
router.get("/drivers", verifyAdminToken, getAllDrivers);
router.put("/driver/block/:driverId", verifyAdminToken, blockDriver);
router.put("/driver/unblock/:driverId", verifyAdminToken, unblockDriver);

// =====================================================
// 🚘 TRIPS
// =====================================================
router.get("/trips", verifyAdminToken, getAllTrips);
router.post("/manual-assign", verifyAdminToken, manualAssignDriver);
router.get("/trip/:tripId", verifyAdminToken, getTripDetails);
router.put("/trip/:tripId/complete", verifyAdminToken, markTripCompleted);
router.put("/trip/:tripId/cancel", verifyAdminToken, cancelTrip);

// =====================================================
// 📨 PUSH NOTIFICATIONS (ADMIN)
// =====================================================
router.post("/send-fcm", verifyAdminToken, sendPushToUsers);
router.post("/send-fcm/individual", verifyAdminToken, sendPushToIndividual);

// =====================================================
// 🔔 USER NOTIFICATIONS (DRIVER & CUSTOMER - Protected)
// =====================================================
// ✅ Fetch notifications for logged-in user (driver/customer)
router.get("/notifications/user", protect, getUserNotifications);

// ✅ Mark single notification as read
router.put("/notifications/:notificationId/read", protect, markNotificationAsRead);

// ✅ Mark all notifications as read
router.put("/notifications/user/read-all", protect, markAllNotificationsAsRead);

// ✅ Delete notification
router.delete("/notifications/:notificationId", protect, deleteNotification);

// =====================================================
// 🔔 ADMIN NOTIFICATIONS (By User ID - Admin Access)
// =====================================================
router.get("/notifications/user/:userId", verifyAdminToken, getUserNotifications);
router.put("/notifications/user/:userId/read-all", verifyAdminToken, markAllNotificationsAsRead);

// =====================================================
// 📄 DOCUMENTS
// =====================================================
router.get("/documents/pending", verifyAdminToken, getPendingDocuments);
router.get("/documents/:driverId", verifyAdminToken, getDriverDocuments);
router.get("/document/:docId", verifyAdminToken, getDocumentById);
router.put("/verifyDocument/:docId", verifyAdminToken, verifyDriverDocument);
router.delete("/document/:docId/image", verifyAdminToken, deleteDriverDocumentImage);

export default router;