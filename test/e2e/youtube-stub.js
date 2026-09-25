// Test double for https://www.youtube.com/iframe_api, used ONLY when youtube.com is unreachable from
// the test environment. It mirrors the documented YT.Player surface and records every call so the
// test can assert CanvasTube drives the official API correctly. It does not play real YouTube media.
export const YT_STUB = `
(function(){
  var PlayerState = {UNSTARTED:-1, ENDED:0, PLAYING:1, PAUSED:2, BUFFERING:3, CUED:5};
  window.__ytCalls = [];
  function Player(el, opts){
    var self = this; this.opts = opts; this.t = (opts.playerVars && opts.playerVars.start) || 0; this.state = -1; this.vol = 100; this.muted = false;
    var frame = document.createElement('iframe');
    frame.setAttribute('data-stub', 'youtube');
    frame.src = 'about:blank';
    frame.title = 'YouTube video player (test stub) ' + opts.videoId;
    el.replaceWith(frame); this.frame = frame;
    window.__ytCalls.push(['new', opts.videoId, JSON.stringify(opts.playerVars)]);
    window.__ytPlayer = this;
    setTimeout(function(){
      if (opts.videoId === 'NOEMBED0001') { opts.events.onError({data:150}); return; }
      opts.events.onReady({target:self});
    }, 50);
    this.timer = setInterval(function(){ if (self.state === 1) self.t += 0.25; if (self.t >= 30 && self.state === 1) self.set(0); }, 250);
  }
  Player.prototype.set = function(s){ this.state = s; this.opts.events.onStateChange({data:s, target:this}); };
  Player.prototype.playVideo = function(){ window.__ytCalls.push(['playVideo']); var s=this; s.set(3); setTimeout(function(){ s.set(1); }, 100); };
  Player.prototype.pauseVideo = function(){ window.__ytCalls.push(['pauseVideo']); this.set(2); };
  Player.prototype.seekTo = function(t, a){ window.__ytCalls.push(['seekTo', t, a]); this.t = t; };
  Player.prototype.setVolume = function(v){ window.__ytCalls.push(['setVolume', v]); this.vol = v; };
  Player.prototype.mute = function(){ window.__ytCalls.push(['mute']); this.muted = true; };
  Player.prototype.unMute = function(){ window.__ytCalls.push(['unMute']); this.muted = false; };
  Player.prototype.getCurrentTime = function(){ return this.t; };
  Player.prototype.getDuration = function(){ return 30; };
  Player.prototype.getVideoLoadedFraction = function(){ return 0.5; };
  Player.prototype.destroy = function(){ window.__ytCalls.push(['destroy']); clearInterval(this.timer); this.frame.remove(); };
  window.YT = { Player: Player, PlayerState: PlayerState };
  setTimeout(function(){ window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(); }, 0);
})();`;
