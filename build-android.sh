#!/bin/bash

###############################################################################
# ZAT POS Android Build Script
# Automates build, test, and deployment process
# Usage: ./build-android.sh [debug|release|test|deploy]
###############################################################################

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/android"
APP_ID="com.zatpos.app"
PACKAGE_NAME="app"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Functions
log_step() {
    echo -e "${BLUE}▶ $1${NC}"
}

log_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

log_error() {
    echo -e "${RED}✗ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

check_requirements() {
    log_step "Checking requirements..."
    
    # Check Java
    if ! command -v java &> /dev/null; then
        log_error "Java not found. Install JDK 11+ and add to PATH."
        exit 1
    fi
    log_success "Java found: $(java -version 2>&1 | head -1)"
    
    # Check Android SDK
    if [ -z "$ANDROID_HOME" ]; then
        log_error "ANDROID_HOME not set. Set it to your Android SDK path."
        exit 1
    fi
    log_success "Android SDK: $ANDROID_HOME"
    
    # Check gradle
    if ! command -v gradle &> /dev/null && ! [ -x "$ANDROID_DIR/gradlew" ]; then
        log_error "Gradle not found. Make sure Android SDK is installed."
        exit 1
    fi
    log_success "Gradle found"
}

sync_capacitor() {
    log_step "Syncing Capacitor files..."
    cd "$PROJECT_ROOT"
    npx cap sync android
    log_success "Capacitor synced"
}

build_debug() {
    log_step "Building debug APK..."
    cd "$ANDROID_DIR"
    ./gradlew assembleDebug -x lint
    
    DEBUG_APK=$(find . -name "app-debug.apk" -type f | head -1)
    if [ -f "$DEBUG_APK" ]; then
        log_success "Debug APK built: $DEBUG_APK"
        echo "$DEBUG_APK"
    else
        log_error "Debug APK not found"
        exit 1
    fi
}

build_release() {
    log_step "Building release APK..."
    
    if [ ! -f "$PROJECT_ROOT/release.keystore" ]; then
        log_error "release.keystore not found. Generate with:"
        echo "  keytool -genkey -v -keystore release.keystore -keyalg RSA -keysize 2048 -alias zatpos-key"
        exit 1
    fi
    
    cd "$ANDROID_DIR"
    ./gradlew assembleRelease -x lint
    
    RELEASE_APK=$(find . -name "app-release-unsigned.apk" -type f | head -1)
    if [ -f "$RELEASE_APK" ]; then
        log_success "Release APK built: $RELEASE_APK"
        echo "$RELEASE_APK"
    else
        log_error "Release APK not found"
        exit 1
    fi
}

install_apk() {
    local apk=$1
    
    if [ -z "$apk" ] || [ ! -f "$apk" ]; then
        log_error "APK file not found: $apk"
        exit 1
    fi
    
    log_step "Installing APK on device/emulator..."
    
    # Check if device is connected
    devices=$(adb devices | grep -v "^List" | grep "device$" | wc -l)
    if [ $devices -eq 0 ]; then
        log_error "No Android device/emulator connected."
        echo "Connect a device via USB or start an emulator."
        exit 1
    fi
    
    adb install "$apk"
    log_success "APK installed"
}

launch_app() {
    log_step "Launching app..."
    adb shell am start -n "$APP_ID/.MainActivity"
    log_success "App launched"
}

show_logs() {
    log_step "Showing app logs (press Ctrl+C to exit)..."
    adb logcat | grep -E "ZAT|Capacitor|ERROR|Exception"
}

run_tests() {
    log_step "Running tests..."
    cd "$ANDROID_DIR"
    ./gradlew connectedAndroidTest -x lint
    log_success "Tests complete"
}

###############################################################################
# Main
###############################################################################

if [ $# -eq 0 ]; then
    echo "ZAT POS Android Build Script"
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  check          Check build requirements"
    echo "  sync           Sync Capacitor files"
    echo "  build-debug    Build debug APK"
    echo "  build-release  Build release APK"
    echo "  install        Install debug APK on device"
    echo "  launch         Launch app on device"
    echo "  logs           Show app logs"
    echo "  test           Run tests"
    echo "  full           Full build, install, and launch (default)"
    echo ""
    exit 0
fi

case "$1" in
    check)
        check_requirements
        ;;
    sync)
        check_requirements
        sync_capacitor
        ;;
    build-debug)
        check_requirements
        sync_capacitor
        build_debug
        ;;
    build-release)
        check_requirements
        sync_capacitor
        build_release
        ;;
    install)
        check_requirements
        apk=$(build_debug)
        install_apk "$apk"
        ;;
    launch)
        launch_app
        ;;
    logs)
        show_logs
        ;;
    test)
        check_requirements
        run_tests
        ;;
    full|*)
        check_requirements
        sync_capacitor
        apk=$(build_debug)
        install_apk "$apk"
        launch_app
        log_success "Build complete!"
        ;;
esac
