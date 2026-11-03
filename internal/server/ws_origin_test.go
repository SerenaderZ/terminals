package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

// 这张表里的每一条都对应一个真实的部署形态。
// 关键是第 1 条：飞牛局域网入口是 http://<ip>:5666，nginx 用 $host 转发时
// 会把端口去掉，旧实现用 HasSuffix 逐字比，于是把正常访问判成跨站，
// 表现就是"远程能用、局域网连不上"。
func TestOriginVerdict(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		host   string
		xfh    string
		want   string
	}{
		{"局域网带端口，网关去掉端口", "http://192.0.2.20:5666", "192.0.2.20", "", originSame},
		{"局域网带端口，网关原样保留", "http://192.0.2.20:5666", "192.0.2.20:5666", "", originSame},
		{"远程访问标准端口", "https://serenader.5ddd.com", "serenader.5ddd.com", "", originSame},
		{"远程访问显式写 443", "https://serenader.5ddd.com:443", "serenader.5ddd.com", "", originSame},
		{"网关把 Host 改成回环，靠 XFH 判断", "http://192.0.2.20:5666", "127.0.0.1:18086", "192.0.2.20", originSame},
		{"XFH 带端口", "http://192.0.2.20:5666", "127.0.0.1:18086", "192.0.2.20:5666", originSame},
		{"IPv6 带端口", "http://[::1]:5666", "[::1]", "", originSame},
		{"别的域名伪造", "http://evil.example", "192.0.2.20", "", originMismatch},
		{"别的域名撞端口", "http://evil.example:5666", "192.0.2.20", "", originMismatch},
		{"主机名不同的两个域名", "https://a.example", "b.example", "", originMismatch},
		{"Origin 不是合法 URL", "null", "192.0.2.20", "", originMismatch},
		{"没有 Origin（curl / 脚本）", "", "192.0.2.20", "", originNoHeader},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, err := http.NewRequest("GET", "http://"+c.host+"/api/ws", nil)
			if err != nil {
				t.Fatalf("构造请求失败：%v", err)
			}
			r.Host = c.host
			if c.origin != "" {
				r.Header.Set("Origin", c.origin)
			}
			if c.xfh != "" {
				r.Header.Set("X-Forwarded-Host", c.xfh)
			}

			if got := originVerdict(r); got != c.want {
				t.Fatalf("originVerdict() = %q，期望 %q", got, c.want)
			}
			// 只有 mismatch 才该被拒，其余一律放行。
			if accept := checkOrigin(r); accept != (c.want != originMismatch) {
				t.Fatalf("checkOrigin() = %v，verdict = %q", accept, c.want)
			}
		})
	}
}

// 多级代理会把多个 host 用逗号连起来，取第一个才有意义。
func TestOriginVerdictMultiValueForwardedHost(t *testing.T) {
	r, err := http.NewRequest("GET", "http://127.0.0.1:18086/api/ws", nil)
	if err != nil {
		t.Fatalf("构造请求失败：%v", err)
	}
	r.Host = "127.0.0.1:18086"
	r.Header.Set("Origin", "http://192.0.2.20:5666")
	r.Header.Set("X-Forwarded-Host", " 192.0.2.20:5666 , proxy.internal ")

	if got := originVerdict(r); got != originSame {
		t.Fatalf("originVerdict() = %q，期望 %q", got, originSame)
	}
}

// 真刀真枪跑一次握手。这一条是用户报的 bug 的最短复现：
// 页面在 5666 上，请求到达服务端时 Host 只剩主机名（端口被网关吃掉）。
// 旧实现用 HasSuffix 逐字比会 403，浏览器那边只会看到 1006。
func TestUpgradeAcceptsPortMismatchOnSameHost(t *testing.T) {
	up := websocket.Upgrader{CheckOrigin: checkOrigin}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		_ = c.WriteMessage(websocket.TextMessage, []byte("ok"))
	}))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	dial := func(origin string) error {
		h := http.Header{}
		h.Set("Origin", origin)
		c, _, err := websocket.DefaultDialer.Dial(wsURL, h)
		if err == nil {
			c.Close()
		}
		return err
	}

	if err := dial("http://127.0.0.1:5666"); err != nil {
		t.Fatalf("同主机不同端口应放行，实际被拒：%v", err)
	}
	if err := dial("http://evil.example:5666"); err == nil {
		t.Fatal("跨站来源必须被拒，实际放行了")
	}
}
