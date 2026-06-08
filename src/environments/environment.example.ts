// Template for the Firebase web config. Copy this file to `environment.ts`
// and fill in your project's values:
//
//   cp src/environments/environment.example.ts src/environments/environment.ts
//
// Grab the values from Firebase Console → Project settings → Your apps → Web
// app → SDK setup and configuration, or run:
//
//   firebase apps:sdkconfig WEB --project <your-project-id>
//
// The web API key is a PUBLIC client identifier (it ships in the browser
// bundle), not a secret — access is controlled by Firestore security rules
// (see firestore.rules) and Google Cloud API-key restrictions, not by hiding
// it. We keep `environment.ts` out of git anyway (see .gitignore).
export const environment = {
  production: false,
  firebase: {
    apiKey: 'YOUR_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    projectId: 'YOUR_PROJECT',
    storageBucket: 'YOUR_PROJECT.firebasestorage.app',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
    measurementId: 'YOUR_MEASUREMENT_ID',
  },
};
