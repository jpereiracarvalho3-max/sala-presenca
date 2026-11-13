/* Recebe as notificações do app Eventos dos Bêbados com o app fechado (Firebase Cloud Messaging). */
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyD8bO9UARwmwFzoAHe03_AV3iLQMPR9sAI",authDomain:"sala-presenca.firebaseapp.com",projectId:"sala-presenca",storageBucket:"sala-presenca.firebasestorage.app",messagingSenderId:"41549125231",appId:"1:41549125231:web:1be6dbefa5d5b47b79df9a"});
firebase.messaging();
