import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location('platform_gate_stack', Path(__file__).with_name('live-stack.py'))
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)


class PlatformGateTests(unittest.TestCase):
    def test_unsupported_runtime_and_state_controls_refuse_before_configuration_or_side_effects(self):
        actions = [
            (False, ['--run', '--confirm-live-runtime', '--config', 'synthetic-not-read']),
            (True, ['--run', '--confirm-readiness-runtime']),
            (True, ['--check', '--confirm-readiness-runtime']),
            (False, ['--status']),
            (False, ['--stop']),
            (True, ['--status']),
            (True, ['--stop']),
        ]
        with (mock.patch.object(stack.sys, 'platform', 'darwin'),
              mock.patch.object(stack, 'configure_runtime', side_effect=AssertionError('manifest read')),
              mock.patch.object(stack, 'load_plan', side_effect=AssertionError('plan read')),
              mock.patch.object(stack, 'run', side_effect=AssertionError('runtime started'))):
            for readiness, arguments in actions:
                with self.subTest(readiness=readiness, arguments=arguments), contextlib.redirect_stdout(io.StringIO()) as output:
                    result = stack.main([*arguments, '--runtime-config', 'synthetic-not-read'], readiness=readiness)
                self.assertEqual(result, 1)
                self.assertEqual(json.loads(output.getvalue()), {'stage': 'supported_runtime_required'})

    def test_native_offline_plan_and_nonsecret_validation_remain_available(self):
        with (mock.patch.object(stack.sys, 'platform', 'win32'),
              mock.patch.object(stack, 'run', side_effect=AssertionError('runtime started'))):
            for readiness in (False, True):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(stack.main([], readiness=readiness), 0)
                plan = json.loads(output.getvalue())
                self.assertFalse(plan['started'])
                self.assertFalse(plan['credentials_read'])
                self.assertFalse(plan['network_checked'])
            with (mock.patch.object(stack, 'configure_runtime'),
                  mock.patch.object(stack, 'load_plan', return_value={'channels': ['qq']}),
                  contextlib.redirect_stdout(io.StringIO()) as output):
                result = stack.main(['--validate-plan', '--runtime-config', 'synthetic', '--config', 'synthetic'])
            self.assertEqual(result, 0)
            validation = json.loads(output.getvalue())
            self.assertTrue(validation['plan_valid'])
            self.assertFalse(validation['runtime_started'])
            self.assertFalse(validation['credentials_read'])
            self.assertFalse(validation['network_checked'])

    def test_confirmation_is_still_required_before_native_runtime_checks(self):
        with (mock.patch.object(stack.sys, 'platform', 'win32'),
              mock.patch.object(stack, 'configure_runtime', side_effect=AssertionError('manifest read'))):
            for readiness, action in ((False, '--run'), (True, '--run'), (True, '--check')):
                with contextlib.redirect_stdout(io.StringIO()) as output:
                    result = stack.main([action, '--runtime-config', 'synthetic-not-read'], readiness=readiness)
                self.assertEqual(result, 1)
                self.assertEqual(json.loads(output.getvalue()), {'stage': 'explicit_plan_and_runtime_confirmation_required'})


if __name__ == '__main__':
    unittest.main()
