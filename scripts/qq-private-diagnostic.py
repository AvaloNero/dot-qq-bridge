#!/usr/bin/env python3
"""User-controlled, masked, memory-only input for the bounded QQ diagnostic.
Run only after separate approval, in the cloud computer terminal under takeover.
This is not a secret store and does not configure the bridge for ongoing access.
"""
import argparse
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description='Existing QQ bot: two-request read-only diagnostic')
    parser.add_argument('--profile', required=True, choices=['documented', 'tencent-sdk', 'tencent-sandbox'])
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise RuntimeError('Use this input only in your interactive cloud-computer terminal.')
    print('Existing QQ bot diagnostic. Enter values yourself while controlling the cloud computer.')
    print('No files or permanent configuration will be written. No QQ messages will be received or sent.')
    print('The selected profile is: ' + args.profile)
    app_id = input('AppID of your existing QQ bot: ').strip()
    secret = getpass.getpass('Existing AppSecret (hidden): ')
    print('Continue sends these values only to the selected official QQ token endpoint,')
    print('then uses the returned token once for official Gateway information. Maximum two requests.')
    token_host = 'api.bot.qq.com' if args.profile == 'documented' else 'bots.qq.com'
    gateway_host = {'documented': 'api.bot.qq.com', 'tencent-sdk': 'api.sgroup.qq.com',
                    'tencent-sandbox': 'sandbox.api.sgroup.qq.com'}[args.profile]
    print('Recipients: https://' + token_host + ' and https://' + gateway_host)
    if input('Type RUN to submit, or anything else to cancel: ') != 'RUN':
        print('Cancelled. Nothing submitted.'); return
    env = {k: v for k, v in os.environ.items() if not k.startswith('QQ_')}
    env.update(QQ_APP_ID=app_id, QQ_BOT_SECRET=secret, QQ_API_PROFILE=args.profile)
    try:
        result = subprocess.run(['node', str(Path(__file__).with_name('qq-cloud-trial.js')),
                                 '--probe', '--confirm-official-read'], env=env,
                                stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                timeout=70, check=False)
        try:
            data = json.loads(result.stdout)
            # Never print subprocess raw stderr or unexpected diagnostic values.
            safe = {}
            if data.get('status') in {'provider_discovery_passed', 'gateway_host_blocked', 'provider_check_failed', 'cancelled_or_expired'}:
                safe['status'] = data['status']
            if data.get('stage') in {'not_started', 'token', 'gateway_discovery', 'gateway_policy'}:
                safe['stage'] = data['stage']
            for k in ['requests', 'last_http_status', 'messages_received', 'messages_sent']:
                if data.get(k) is None or type(data.get(k)) is int:
                    safe[k] = data.get(k)
            for k in ['gateway_host_allowed', 'gateway_quota_available', 'credentials_written',
                      'live_gateway_connected', 'owner_identity_verified', 'current_dot_connected']:
                if type(data.get(k)) is bool:
                    safe[k] = data[k]
            print(json.dumps(safe, indent=2))
        except (json.JSONDecodeError, TypeError):
            print('Diagnostic failed; input values and raw errors were not printed.')
    finally:
        env.pop('QQ_BOT_SECRET', None)
        secret = None
    print('Diagnostic finished. No bridge was started or credentials saved.')


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nCancelled. No credentials were saved.')
    except Exception:
        print('Diagnostic stopped. Input values and raw errors were not printed.')
        sys.exit(1)
