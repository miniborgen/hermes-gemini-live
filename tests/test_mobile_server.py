from hermes_gemini_live.mobile_server import build_parser


def test_mobile_server_binds_loopback_and_requires_an_allowlisted_tailnet_login():
    parser = build_parser()
    args = parser.parse_args(["--allowed-login", "magnus.borg@gmail.com"])

    assert args.host == "127.0.0.1"
    assert args.port == 65183
    assert args.allowed_login == "magnus.borg@gmail.com"
