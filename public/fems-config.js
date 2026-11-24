/* FEMS settings for this Firebase project. These web values are not secret. */
window.FEMS_CONFIG = {
  ownerEmails: ["rogadogerick@gmail.com", "nexorasystems725@gmail.com"],
  firebase: {
    apiKey: "AIzaSyBieYiyQnNyebcC7RMYymgmlUwfeAKHCjI",
    authDomain: "fems-nexora.firebaseapp.com",
    projectId: "fems-nexora",
    storageBucket: "fems-nexora.firebasestorage.app",
    messagingSenderId: "247075667056",
    appId: "1:247075667056:web:222f1ce5f5f2d9f4b688b5"
  }
};
if (/[?&]emulator=1/.test(location.search) || location.hostname === "localhost" && /[?&]emu/.test(location.search)) window.FEMS_CONFIG.emulator = location.hostname;
