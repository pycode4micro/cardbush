This self-signed certificate and disposable test private key are only for the loopback HTTPS
server in `test-plugin-proxy-electron.cjs`. They do not identify any real service.
The isolated test session trusts only this certificate fingerprint at 127.0.0.1;
production certificate verification is unchanged.
