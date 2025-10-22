const handleFCMError = (error) => {
  if (error.message.includes('entity was not found')) {
    console.error('FCM Error: Device token or recipient not found');
    // Optionally remove invalid tokens from your database
    return {
      success: false,
      error: 'RECIPIENT_NOT_FOUND',
      message: 'Unable to send notification - recipient not found'
    };
  }
  
  return {
    success: false,
    error: 'FCM_ERROR',
    message: error.message
  };
};

export const sendFCMNotification = async (token, message) => {
  try {
    // Your existing FCM send logic here
    const response = await admin.messaging().send({
      token,
      notification: message
    });
    return { success: true, response };
  } catch (error) {
    return handleFCMError(error);
  }
};