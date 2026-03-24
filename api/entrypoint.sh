#!/bin/sh
set -e  # Exit on error

# Function to log with timestamp
log() {
    if [ "$DEBUG" = "true" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    fi
}

is_headless() {
    case "${CHROME_HEADLESS:-true}" in
        true|1|TRUE|True|yes|YES)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Initialize DBus
init_dbus() {
    log "Initializing DBus..."
    mkdir -p /var/run/dbus

    if [ -e /var/run/dbus/pid ]; then
        rm -f /var/run/dbus/pid
    fi

    dbus-daemon --system --fork
    sleep 2  # Give DBus time to initialize

    if dbus-send --system --print-reply --dest=org.freedesktop.DBus \
        /org/freedesktop/DBus org.freedesktop.DBus.ListNames >/dev/null 2>&1; then
        log "DBus initialized successfully"
        return 0
    else
        log "ERROR: DBus failed to initialize"
        return 1
    fi
}

# Verify Chrome and ChromeDriver installation
verify_chrome() {
    log "Verifying Chrome installation..."

    # Check Chrome binary and version
    if [ ! -f "/usr/bin/chromium" ] && [ -z "$CHROME_EXECUTABLE_PATH" ]; then
        log "ERROR: Chrome binary not found at /usr/bin/chromium and CHROME_EXECUTABLE_PATH not set"
        return 1
    fi

    if [ -f "/usr/bin/chromium" ]; then
        chrome_version=$(chromium --version 2>/dev/null || echo "unknown")
    elif [ -n "$CHROME_EXECUTABLE_PATH" ] && [ -f "$CHROME_EXECUTABLE_PATH" ]; then
        chrome_version=$("$CHROME_EXECUTABLE_PATH" --version 2>/dev/null || echo "unknown")
    else
        chrome_version="unknown"
    fi
    log "Chrome version: $chrome_version"

    # Check ChromeDriver binary and version
    if [ ! -f "/usr/bin/chromedriver" ]; then
        log "ERROR: ChromeDriver not found at /usr/bin/chromedriver"
        return 1
    fi

    chromedriver_version=$(chromedriver --version 2>/dev/null || echo "unknown")
    log "ChromeDriver version: $chromedriver_version"

    log "Chrome environment configured successfully"
    return 0
}

start_virtual_display() {
    if is_headless; then
        log "Skipping Xvfb startup in headless mode"
        return 0
    fi

    display_value="${DISPLAY:-:10}"
    export DISPLAY="$display_value"
    display_number="${DISPLAY#:}"
    display_number="${display_number%%.*}"
    x_lock_file="/tmp/.X${display_number}-lock"
    x_socket_file="/tmp/.X11-unix/X${display_number}"

    if xset -display "$DISPLAY" q >/dev/null 2>&1; then
        log "Using existing X display at $DISPLAY"
        return 0
    fi

    if [ -f "$x_lock_file" ] || [ -S "$x_socket_file" ]; then
        log "Removing stale X server artifacts for $DISPLAY"
        rm -f "$x_lock_file"
        rm -f "$x_socket_file"
    fi

    if ! command -v Xvfb >/dev/null 2>&1; then
        echo "ERROR: Xvfb is required for headful Chrome but is not installed" >&2
        return 1
    fi

    log "Starting Xvfb on $DISPLAY"
    Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac +extension RANDR >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    export XVFB_PID

    attempt=1
    max_attempts=20
    while [ $attempt -le $max_attempts ]; do
        if xset -display "$DISPLAY" q >/dev/null 2>&1; then
            log "Xvfb is ready on $DISPLAY"
            return 0
        fi

        if ! kill -0 "$XVFB_PID" >/dev/null 2>&1; then
            echo "ERROR: Xvfb exited before becoming ready" >&2
            cat /tmp/xvfb.log >&2 || true
            return 1
        fi

        sleep 0.5
        attempt=$((attempt + 1))
    done

    echo "ERROR: Timed out waiting for Xvfb on $DISPLAY" >&2
    cat /tmp/xvfb.log >&2 || true
    return 1
}

# Start nginx with better error handling
start_nginx() {
    if [ "$START_NGINX" = "true" ]; then
        log "Starting nginx..."
        nginx -c /app/api/nginx.conf
        
        # Wait for nginx to start
        max_attempts=10
        attempt=1
        while [ $attempt -le $max_attempts ]; do
            if nginx -t >/dev/null 2>&1; then
                log "Nginx started successfully"
                return 0
            fi
            log "Attempt $attempt/$max_attempts: Waiting for nginx..."
            attempt=$((attempt + 1))
            sleep 1
        done
        log "ERROR: Nginx failed to start properly"
        return 1
    else
        log "Skipping nginx startup (--no-nginx flag detected)"
        return 0
    fi
}

# Main execution
main() {
    # Parse arguments
    START_NGINX=true
    for arg in "$@"; do
        if [ "$arg" = "--no-nginx" ]; then
            START_NGINX=false
            break
        fi
    done
    
    if [ "$DEBUG" = "true" ] || ! is_headless; then
        init_dbus || exit 1
        verify_chrome || exit 1
    fi
    start_nginx || exit 1
    
    # Set required environment variables
    export CDP_REDIRECT_PORT=9223
    export DISPLAY="${DISPLAY:-:10}"
    start_virtual_display || exit 1
    
    # Log environment state
    log "Environment configuration:"
    log "HOST=$HOST"
    log "CDP_REDIRECT_PORT=$CDP_REDIRECT_PORT"
    log "NODE_ENV=$NODE_ENV"
    log "CHROME_HEADLESS=${CHROME_HEADLESS:-true}"
    log "DISPLAY=$DISPLAY"
    
    # Start the application
    # Run the `npm run start` command but without npm.
    # NPM will introduce its own signal handling
    # which will prevent the container from waiting
    # for a session to be released before stopping gracefully
    log "Starting Steel Browser API..."
    exec node ./api/build/index.js
}

main "$@"
