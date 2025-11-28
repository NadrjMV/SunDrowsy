// Configuração do Firebase
const firebaseConfig = {
  apiKey: "AIzaSyAOWCHO9cgm7mw4Sh24HTO9iUX8fDdvLcs",
  authDomain: "sundrowsy-db163.firebaseapp.com",
  projectId: "sundrowsy-db163",
  storageBucket: "sundrowsy-db163.firebasestorage.app",
  messagingSenderId: "613641030844",
  appId: "1:613641030844:web:ffd23d33da8d84321c54b9",
  measurementId: "G-1P47PL1TCS"
};

// Inicializa Firebase
firebase.initializeApp(firebaseConfig);
export const auth = firebase.auth();
export const db = firebase.firestore();
export const googleProvider = new firebase.auth.GoogleAuthProvider();