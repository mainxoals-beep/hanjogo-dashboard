// 구글 애널리틱스(GA4). 동문 공개 페이지와 동문 지도에서만 불러옵니다.
// 내부 대시보드(index.html)에는 넣지 않습니다.
//
// 구글에는 페이지 주소만 보냅니다. 이메일 로그인 링크는 주소 뒤(#, ?)에 인증 정보가
// 붙어 오므로, 그 부분을 잘라낸 주소를 직접 넘깁니다. 이름·이메일은 보내지 않습니다.
(function () {
  var ID = "G-85FW546F0T";
  if (!/(^|\.)github\.io$/.test(location.hostname)) return; // 로컬 테스트에서는 집계하지 않습니다.

  function cleanUrl(value) {
    try {
      var url = new URL(value, location.href);
      return url.origin + url.pathname;
    } catch (e) {
      return "";
    }
  }

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", ID, {
    page_location: cleanUrl(location.href),
    page_referrer: document.referrer ? cleanUrl(document.referrer) : "",
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  var script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtag/js?id=" + ID;
  document.head.appendChild(script);
})();
