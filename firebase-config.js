// Replace with YOUR Firebase project config (same place you got it for your
// taxi/maintenance PWA — Firebase Console > Project Settings > General > Your apps)
const firebaseConfig = {
  apiKey: "AIzaSyCQ6ysW7QlLNelAEtTWlIJBffa4fK4zR8c",
  authDomain: "nexconnect-71c79.firebaseapp.com",
  projectId: "nexconnect-71c79",
  storageBucket: "nexconnect-71c79.firebasestorage.app",
  messagingSenderId: "301617290013",
  appId: "1:301617290013:web:8c42f6215b7e3ba41d9ff4"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
