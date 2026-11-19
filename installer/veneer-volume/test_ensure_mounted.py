import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('ensure_mounted', pathlib.Path(__file__).with_name('ensure-mounted.py'))
em = importlib.util.module_from_spec(spec)
spec.loader.exec_module(em)


class Clock:
    def __init__(self): self.now = 0
    def sleep(self, seconds): self.now += seconds
    def clock(self): return self.now


class RetryUntil(unittest.TestCase):
    def run_steps(self, outcomes, deadline=180):
        clock, calls, lines = Clock(), [], []
        def step():
            calls.append(clock.now)
            outcome = outcomes[min(len(calls), len(outcomes)) - 1]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        try:
            result = em.retry_until(step, deadline, sleep=clock.sleep, clock=clock.clock, log=lines.append)
        except Exception as error:
            result = error
        return result, calls, lines

    def test_returns_first_success_without_waiting(self):
        result, calls, lines = self.run_steps([0])
        self.assertEqual((result, calls, lines), (0, [0], []))

    def test_retries_every_five_seconds_until_ready(self):
        result, calls, lines = self.run_steps([em.Retry('absent'), em.Retry('locked'), 0])
        self.assertEqual((result, calls), (0, [0, 5, 10]))
        self.assertEqual(lines, ['attempt 1: absent', 'attempt 2: locked'])

    def test_gives_up_at_the_deadline_with_the_last_reason(self):
        result, calls, _ = self.run_steps([em.Retry('absent')], deadline=12)
        self.assertIsInstance(result, em.Retry)
        self.assertEqual(calls, [0, 5, 10])

    def test_safety_failures_are_never_retried(self):
        result, calls, _ = self.run_steps([RuntimeError('Unexpected disk identity'), 0])
        self.assertIsInstance(result, RuntimeError)
        self.assertEqual(calls, [0])


if __name__ == '__main__':
    unittest.main()
