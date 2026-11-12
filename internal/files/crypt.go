package files

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// secretBox 负责远程连接的密码、私钥口令这类东西的落盘加密。
//
// 说明白它防的是什么：防的是"别人顺手看到配置文件"——数据目录备份被拷走、
// 或者有人能读文件但拿不到 root。密钥和密文放在同一个目录里，所以拿到
// 整个数据目录的人照样能解开。真要防住那种情况，得让用户每次连接都手输
// 密码，那就不叫可视化管理了。
//
// 用 AES-GCM 而不是自己拼 Xor：GCM 自带完整性校验，密文被改过会直接报错，
// 不会解出一段乱七八糟的东西当成密码去撞服务器。
type secretBox struct {
	aead cipher.AEAD
}

// loadSecretBox 读取（或首次生成）密钥文件。
func loadSecretBox(path string) (*secretBox, error) {
	key, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, err
		}
		key = make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		if err := os.WriteFile(path, key, 0o600); err != nil {
			return nil, err
		}
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("密钥文件 %s 长度不对（%d 字节），应删除后重填密码", path, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &secretBox{aead: aead}, nil
}

// seal 加密。空串原样返回空串 —— "没有密码"和"密码是空字符串"是一回事。
func (b *secretBox) seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	out := b.aead.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(out), nil
}

// open 解密。解不开就返回错误，让调用方提示"重新填一次密码"，
// 而不是拿一段乱码去连服务器。
func (b *secretBox) open(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", errors.New("保存的密码已损坏，请重新填写")
	}
	n := b.aead.NonceSize()
	if len(raw) < n {
		return "", errors.New("保存的密码已损坏，请重新填写")
	}
	plain, err := b.aead.Open(nil, raw[:n], raw[n:], nil)
	if err != nil {
		return "", errors.New("保存的密码解不开（密钥文件被换过），请重新填写")
	}
	return string(plain), nil
}
