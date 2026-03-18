(function() {
  const container = document.getElementById('content');

  // The token is in the URL hash fragment (#access_token=...)
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  const token = params.get('access_token');
  const error = params.get('error');

  if (error) {
    container.innerHTML =
      '<div class="error">&#10007;</div>' +
      '<h2>Sign-in failed</h2>' +
      '<p>Error: ' + error.replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])) + '</p>' +
      '<p>You can close this tab and try again.</p>';
    return;
  }

  if (token) {
    chrome.runtime.sendMessage({ type: 'oauthToken', token: token }, function(response) {
      if (chrome.runtime.lastError) {
        container.innerHTML =
          '<div class="error">&#10007;</div>' +
          '<h2>Error</h2>' +
          '<p>' + (chrome.runtime.lastError.message || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]) ) + '</p>' +
          '<p>You can close this tab and try again.</p>';
        return;
      }
      container.innerHTML =
        '<div class="success">&#10003;</div>' +
        '<h2>Signed in successfully!</h2>' +
        '<p>This tab will close automatically...</p>';
      setTimeout(function() { window.close(); }, 1500);
    });
  } else {
    container.innerHTML =
      '<div class="error">&#10007;</div>' +
      '<h2>Sign-in failed</h2>' +
      '<p>No access token received. Please try again.</p>' +
      '<p>You can close this tab.</p>';
  }
})();
