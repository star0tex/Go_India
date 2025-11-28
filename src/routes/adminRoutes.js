import express from "express";
import { verifyAdminToken } from "../middlewares/adminAuth.js";
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
  
  // 🧪 TEST - Add this import
  testImageAccess,
} from "../controllers/adminController.js";

const router = express.Router();

// =====================================================
// 🧪 TEST ENDPOINTS (Add these at the top for easy access)
// =====================================================
// Without auth for quick testing:
router.get("/test-images", testImageAccess);
// Or with auth:
// router.get("/test-images", verifyAdminToken, testImageAccess);

// =====================================================
// EXISTING ROUTES
// =====================================================

// Fare Rates
router.get("/fare/rates", verifyAdminToken, getAllFareRates);
router.put("/fare/update/:id", verifyAdminToken, updateFareRate);
router.post("/fare/create", verifyAdminToken, createFareRate);
router.delete("/fare/delete/:id", verifyAdminToken, deleteFareRate);

// 🟡 Admin Login (Public)
router.post("/login", adminLogin);

// 🟢 Dashboard Stats
router.get("/stats", verifyAdminToken, getDashboardStats);

// 🧑 Customers
router.get("/customers", verifyAdminToken, getAllCustomers);
router.put("/customer/block/:customerId", verifyAdminToken, blockCustomer);
router.put("/customer/unblock/:customerId", verifyAdminToken, unblockCustomer);

// 🚖 Drivers
router.get("/drivers", verifyAdminToken, getAllDrivers);
router.put("/driver/block/:driverId", verifyAdminToken, blockDriver);
router.put("/driver/unblock/:driverId", verifyAdminToken, unblockDriver);

// 🚘 Trips
router.get("/trips", verifyAdminToken, getAllTrips);
router.post("/manual-assign", verifyAdminToken, manualAssignDriver);
router.get("/trip/:tripId", verifyAdminToken, getTripDetails);
router.put("/trip/:tripId/complete", verifyAdminToken, markTripCompleted);
router.put("/trip/:tripId/cancel", verifyAdminToken, cancelTrip);

// 📨 Push Notifications
router.post("/send-fcm", verifyAdminToken, sendPushToUsers);
router.post("/send-fcm/individual", verifyAdminToken, sendPushToIndividual);

// 🔔 Notifications
router.get("/notifications/user/:userId", getUserNotifications);
router.put("/notifications/:notificationId/read", markNotificationAsRead);
router.put("/notifications/user/:userId/read-all", markAllNotificationsAsRead);
router.delete("/notifications/:notificationId", deleteNotification);

// 📄 Documents
router.get("/documents/pending", verifyAdminToken, getPendingDocuments);
router.get("/documents/:driverId", verifyAdminToken, getDriverDocuments);
router.get("/document/:docId", verifyAdminToken, getDocumentById);
router.put("/verifyDocument/:docId", verifyAdminToken, verifyDriverDocument);
router.delete("/document/:docId/image", verifyAdminToken, deleteDriverDocumentImage);

export default router;