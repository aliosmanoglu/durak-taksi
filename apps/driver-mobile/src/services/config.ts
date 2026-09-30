// API adresi derleme zamanında `EXPO_PUBLIC_API_URL` ile verilir (bkz. .env.example).
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://10.0.2.2:3000').replace(/\/+$/, '');
