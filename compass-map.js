/* Phone heading-up mode. Keep map center/zoom untouched. */
(() => {
  const map = window.cartDeliveryMap;
  const button = document.getElementById('headingUpMapBtn');
  const status = document.getElementById('headingUpMapStatus');
  const northButton = document.getElementById('northUpMapBtn');
  if (!map || !button) return;
  let enabled = false;
  let lastHeading = null;
  let lastUpdate = 0;
  const normalize = value => ((value % 360) + 360) % 360;
  const message = text => { status.textContent = text; status.hidden = !text; };
  function stop() {
    enabled = false;
    window.removeEventListener('deviceorientation', onOrientation, true);
    window.removeEventListener('deviceorientationabsolute', onOrientation, true);
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    button.title = 'Orient map to phone';
    if (typeof map.setBearing === 'function') map.setBearing(0);
  }
  function onOrientation(event) {
    if (!enabled) return;
    let heading = typeof event.webkitCompassHeading === 'number' && event.webkitCompassAccuracy !== -1
      ? event.webkitCompassHeading
      : (event.absolute === true && event.alpha != null ? 360 - event.alpha : null);
    if (heading == null || !Number.isFinite(heading)) return;
    heading = normalize(heading);
    const now = performance.now();
    if (lastHeading !== null && now - lastUpdate < 80) return;
    lastHeading = heading;
    lastUpdate = now;
    map.setBearing(normalize(-heading));
    button.style.setProperty('--heading-degrees', heading + 'deg');
    message('');
  }
  button.addEventListener('click', async () => {
    if (enabled) { stop(); message('North up'); return; }
    if (!window.isSecureContext || typeof DeviceOrientationEvent === 'undefined' || typeof map.setBearing !== 'function') {
      message('Compass unavailable on this device or connection. Open the app over HTTPS.');
      return;
    }
    try {
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        const permission = await DeviceOrientationEvent.requestPermission();
        if (permission !== 'granted') { message('Allow motion and orientation access to use compass mode.'); return; }
      }
      enabled = true;
      lastHeading = null;
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      button.title = 'Turn off heading-up map';
      message('Point the top of your phone toward an address');
      window.addEventListener('deviceorientation', onOrientation, true);
      window.addEventListener('deviceorientationabsolute', onOrientation, true);
    } catch (error) {
      stop();
      message('Compass access was blocked. Check Safari motion permissions.');
    }
  });
  // Offer north-up reset whenever the map has been rotated manually or by compass.
  function updateNorthButton() {
    const bearing = typeof map.getBearing === 'function' ? map.getBearing() : 0;
    if (!northButton) return;
    northButton.hidden = Math.abs(((bearing + 180) % 360 + 360) % 360 - 180) < 1;
    northButton.style.setProperty('--north-bearing', (-bearing) + 'deg');
  }
  if (northButton) northButton.addEventListener('click', () => {
    if (enabled) stop();
    if (typeof map.setBearing === 'function') map.setBearing(0);
    updateNorthButton();
    message('North up');
  });
  map.on('rotate', updateNorthButton);
  map.on('rotateend', updateNorthButton);
  updateNorthButton();
  window.addEventListener('pagehide', () => {
    window.removeEventListener('deviceorientation', onOrientation, true);
    window.removeEventListener('deviceorientationabsolute', onOrientation, true);
  });
})();
