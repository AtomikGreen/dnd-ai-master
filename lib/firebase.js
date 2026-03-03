import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD-s5vlwe88hSE1CZCDK2WqpR5AVoRbqcQ",
  authDomain: "dnd-master-dev.firebaseapp.com",
  projectId: "dnd-master-dev",
  storageBucket: "dnd-master-dev.firebasestorage.app",
  messagingSenderId: "635128867811",
  appId: "1:635128867811:web:2fb6f01365e6de921eced6",
  measurementId: "G-V6KMFM85N4"
};

// Initialisation de Firebase
const app = initializeApp(firebaseConfig);

// Exportation de la base de données pour l'utiliser ailleurs dans notre code
export const db = getFirestore(app);