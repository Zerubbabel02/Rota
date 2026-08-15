-- Native (Capacitor/Android) biometric confirm can't use WebAuthn — the
-- embedded WebView doesn't implement navigator.credentials. Instead the
-- device stores an opaque secret behind Android Keystore + BiometricPrompt
-- (via capacitor-native-biometric); the server only ever sees its
-- PBKDF2 hash, mirroring how the existing PIN is stored (pin_hash/pin_salt).
alter table profiles
  add column if not exists native_biometric_hash text,
  add column if not exists native_biometric_salt text;
