import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zatpos.app',
  appName: 'ZAT POS',
  webDir: 'offline-pos',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#ffffff',
      launchShowDuration: 3000,
    },
    Network: {},
    Camera: {
      permissions: ['photos', 'camera'],
    },
    Filesystem: {
      permissions: ['readWrite'],
    },
  },
};

export default config;
