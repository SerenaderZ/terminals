//go:build windows

package session

// EnsureHome 在 Windows 上不做任何事：本地调试用的是当前账户，home 一定在。
func EnsureHome(cfg *Config, dataDir string) string { return "" }
