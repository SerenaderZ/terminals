package files

import "errors"

// ErrLocalOnly 表示这个来源不支持该操作。
var ErrLocalOnly = errors.New("这个来源不支持该操作")

// Service 把本机视图、远程连接清单和连接池绑在一起。
//
// HTTP 层只认它：给一个来源 id（"local" 或连接 id），拿回一个 FS。
type Service struct {
	local *Local
	store *Store
	pool  *Pool
}

// NewService 创建服务。store 可以为 nil（没有数据目录的开发模式），
// 那种情况下只提供本机视图。
func NewService(local *Local, store *Store) *Service {
	pool := NewPool()
	if store != nil {
		// 首次连接顺手把主机指纹和远端 home 记下来，下次就不必再探。
		pool.OnHostKey = store.SetHostKey
		pool.OnHome = store.SetHome
	}
	return &Service{local: local, store: store, pool: pool}
}

// Local 返回本机视图。
func (s *Service) Local() FS { return s.local }

// Store 返回连接清单；可能为 nil。
func (s *Service) Store() *Store { return s.store }

// FS 按来源取一个文件视图。空串和 "local" 都是本机。
func (s *Service) FS(id string) (FS, error) {
	if id == "" || id == "local" {
		return s.local, nil
	}
	if s.store == nil {
		return nil, ErrNotFound
	}
	c, ok := s.store.Get(id)
	if !ok {
		return nil, ErrNotFound
	}
	return NewRemote(c, s.pool), nil
}

// Home 返回某个来源的起始目录。
//
// 远程连接的 home 只有连上之后才知道（SFTP 没有本地状态可查），所以这里
// 允许真的连一次；结果由连接池的 OnHome 回调写进配置，下次直接就答得出来。
func (s *Service) Home(id string) (string, error) {
	if id == "" || id == "local" {
		return s.local.Home(), nil
	}
	if s.store == nil {
		return "", ErrNotFound
	}
	c, ok := s.store.Get(id)
	if !ok {
		return "", ErrNotFound
	}
	return s.pool.Home(c)
}

// Test 用一份临时连接试连一次，返回远端 home。
//
// 不走连接池：这是一次性探测，失败的连接不该留在池里占位。
func (s *Service) Test(c Conn) (string, error) {
	if err := validateConn(c); err != nil {
		return "", err
	}
	e, err := dialRemote(c)
	if err != nil {
		return "", err
	}
	defer func() {
		_ = e.sftp.Close()
		_ = e.ssh.Close()
	}()
	return e.sftp.Getwd()
}

// DropConn 关掉某条连接的池化连接（改配置、删除连接时调用）。
func (s *Service) DropConn(id string) { s.pool.Drop(id) }

// Close 关掉全部远程连接。
func (s *Service) Close() { s.pool.Close() }
