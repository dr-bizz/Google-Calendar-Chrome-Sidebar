(function() {
  const container = document.getElementById('content');
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);

  const provider = params.get('provider');
  const error = params.get('error');
  const sessionToken = params.get('session_token');
  const accessToken = params.get('access_token');
  const expiresIn = params.get('expires_in');

  // Clear sensitive tokens from URL bar and browser history
  history.replaceState(null, '', window.location.pathname);

  if (error) {
    const safeError = error.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
    container.innerHTML =
      '<div class="error">&#10007;</div>' +
      '<h2>Sign-in failed</h2>' +
      '<p>Error: ' + safeError + '</p>' +
      '<p>You can close this tab and try again.</p>';
    return;
  }

  if (!sessionToken || !provider) {
    container.innerHTML =
      '<div class="error">&#10007;</div>' +
      '<h2>Sign-in failed</h2>' +
      '<p>No session received. Please try again.</p>' +
      '<p>You can close this tab.</p>';
    return;
  }

  // Build message based on provider
  const message = { type: 'oauthCallback', provider, sessionToken };
  if (provider === 'google' && accessToken) {
    message.accessToken = accessToken;
    message.expiresIn = parseInt(expiresIn, 10) || 3600;
  }

  chrome.runtime.sendMessage(message, function(_response) {
    if (chrome.runtime.lastError) {
      const safeMsg = (chrome.runtime.lastError.message || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
      container.innerHTML =
        '<div class="error">&#10007;</div>' +
        '<h2>Error</h2>' +
        '<p>' + safeMsg + '</p>' +
        '<p>You can close this tab and try again.</p>';
      return;
    }

    const label = provider === 'google' ? 'Google Calendar' : 'GitHub';
    container.innerHTML =
      '<div class="success">&#10003;</div>' +
      '<h2>Connected to ' + label + '!</h2>' +
      '<p>This tab will close automatically...</p>';
    setTimeout(function() { window.close(); }, 1500);
  });
})();
