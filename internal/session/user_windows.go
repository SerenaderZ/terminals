//go:build windows

package session

// spawnCred 在 Windows 上没有意义，只用于让跨平台签名一致。
type spawnCred struct{}

// PrepareRunAs 在 Windows 上是空操作。
//
// 本地开发不做降权：ConPTY 本身也没有 unix 那套凭据语义，
// 而正式目标是飞牛的 Linux。
func PrepareRunAs(cfg *Config) error {
	if cfg.RunAs == "" {
		cfg.RunAs = currentUser()
	}
	cfg.RunAsHome = homeDir()
	cfg.Sudo = false
	return nil
}

// credentialFor 在 Windows 上永远返回 nil，表示沿用当前进程身份。
func credentialFor(string) (*spawnCred, error) {
	return nil, nil
}
