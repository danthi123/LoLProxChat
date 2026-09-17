//! Pure decision logic for the low-level keyboard hook (#27).
//!
//! Deliberately free of any `windows` imports: `global_keys` does the Win32
//! translation (message id -> `Edge`, `KBDLLHOOKSTRUCT.flags` -> `injected`)
//! and feeds this module plain scalars, so the part that is actually easy to
//! get wrong is unit-testable on any host.

/// Win32 `VK_CAPITAL`.
pub const VK_CAPITAL: u32 = 0x14;

/// Which transition a keyboard event represents. `Other` covers the message
/// ids the hook does not act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Down,
    Up,
    Other,
}

/// The event to forward to the JS side, if any.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Emit {
    None,
    PttDown,
    PttUp,
    ToggleMute,
}

/// What the hook should do with one keyboard event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub emit: Emit,
    /// Send one synthetic Caps Lock press to cancel the toggle the OS applies
    /// when the key goes down.
    pub flip_caps: bool,
    /// New value for the caller's "Caps Lock is currently held" flag.
    pub caps_held: bool,
}

/// Decide what to do with a single keyboard event.
///
/// Windows toggles Caps Lock once per *press* — on the down transition only,
/// and not again for typematic repeats. So the cancelling flip must fire on
/// exactly the first down edge of a hold: `caps_held` makes that idempotent
/// across repeats, and the up edge must do nothing at all (a release carries
/// no toggle, so flipping there inverted the state on every PTT press — #27).
pub fn decide(
    vk: u32,
    edge: Edge,
    ptt_vk: u32,
    toggle_vk: u32,
    injected: bool,
    caps_held: bool,
) -> Decision {
    // Our own SendInput flip comes back through the hook as an injected
    // down+up pair. Letting it touch `caps_held` would clear the flag while
    // the physical key is still down, so the next repeat would flip again.
    if injected {
        return Decision { emit: Emit::None, flip_caps: false, caps_held };
    }

    let next_caps_held = if vk == VK_CAPITAL {
        match edge {
            Edge::Down => true,
            Edge::Up => false,
            Edge::Other => caps_held,
        }
    } else {
        caps_held
    };

    // `VK_CAPITAL != 0`, so this also covers the unbound (`ptt_vk == 0`) case.
    let flip_caps =
        ptt_vk == VK_CAPITAL && vk == VK_CAPITAL && edge == Edge::Down && !caps_held;

    let emit = if ptt_vk != 0 && vk == ptt_vk {
        match edge {
            Edge::Down => Emit::PttDown,
            Edge::Up => Emit::PttUp,
            Edge::Other => Emit::None,
        }
    } else if toggle_vk != 0 && vk == toggle_vk && edge == Edge::Down {
        Emit::ToggleMute
    } else {
        Emit::None
    };

    Decision { emit, flip_caps, caps_held: next_caps_held }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F8: u32 = 0x77;

    fn caps(edge: Edge, caps_held: bool) -> Decision {
        decide(VK_CAPITAL, edge, VK_CAPITAL, 0, false, caps_held)
    }

    /// The first down edge of a Caps Lock PTT press emits PttDown and fires
    /// exactly one cancelling flip, and marks the key held.
    #[test]
    fn caps_down_emits_and_flips_once() {
        let d = caps(Edge::Down, false);
        assert_eq!(d.emit, Emit::PttDown);
        assert!(d.flip_caps);
        assert!(d.caps_held);
    }

    /// The release must NOT flip. This is the #27 bug: a key-up carries no OS
    /// toggle, so the old `(is_down || is_up)` flip inverted Caps Lock once
    /// per completed press. Reverting the fix makes this assertion fail.
    #[test]
    fn caps_up_emits_but_never_flips() {
        let d = caps(Edge::Up, true);
        assert_eq!(d.emit, Emit::PttUp);
        assert!(!d.flip_caps);
        assert!(!d.caps_held);
    }

    /// Parity over one complete press-and-release: exactly one flip, matching
    /// the single OS toggle on the down transition. Net change: zero.
    #[test]
    fn press_and_release_flips_exactly_once() {
        let mut held = false;
        let mut flips = 0;
        for edge in [Edge::Down, Edge::Up] {
            let d = caps(edge, held);
            held = d.caps_held;
            if d.flip_caps {
                flips += 1;
            }
        }
        assert_eq!(flips, 1);
        assert!(!held);
    }

    /// Typematic repeat: WH_KEYBOARD_LL re-delivers WM_KEYDOWN for a held key
    /// and KBDLLHOOKSTRUCT carries no repeat count, so the held flag is the
    /// only thing keeping repeats from accumulating spurious flips.
    #[test]
    fn auto_repeat_flips_only_on_the_first_down() {
        let mut held = false;
        let mut flips = 0;
        for _ in 0..10 {
            let d = caps(Edge::Down, held);
            held = d.caps_held;
            if d.flip_caps {
                flips += 1;
            }
            assert_eq!(d.emit, Emit::PttDown);
        }
        let up = caps(Edge::Up, held);
        assert!(!up.flip_caps);
        assert_eq!(flips, 1);
    }

    /// Injected events are inert in all three outputs, including `caps_held`:
    /// our own flip re-enters the hook as an injected Caps Lock down+up, and
    /// letting its up edge clear the flag would re-arm the next repeat.
    #[test]
    fn injected_events_change_nothing() {
        for edge in [Edge::Down, Edge::Up, Edge::Other] {
            for held in [false, true] {
                let d = decide(VK_CAPITAL, edge, VK_CAPITAL, 0, true, held);
                assert_eq!(d.emit, Emit::None);
                assert!(!d.flip_caps);
                assert_eq!(d.caps_held, held);
            }
        }
    }

    /// A non-Caps PTT bind drives PTT normally and never synthesises a
    /// keystroke — the flip is a Caps-Lock-only workaround.
    #[test]
    fn non_caps_ptt_never_flips() {
        let down = decide(F8, Edge::Down, F8, 0, false, false);
        assert_eq!(down.emit, Emit::PttDown);
        assert!(!down.flip_caps);

        let up = decide(F8, Edge::Up, F8, 0, false, false);
        assert_eq!(up.emit, Emit::PttUp);
        assert!(!up.flip_caps);
    }

    /// Caps Lock pressed while PTT is bound elsewhere is a plain Caps Lock
    /// press: no emit, no flip.
    #[test]
    fn caps_is_untouched_when_ptt_is_bound_elsewhere() {
        let d = decide(VK_CAPITAL, Edge::Down, F8, 0, false, false);
        assert_eq!(d.emit, Emit::None);
        assert!(!d.flip_caps);
        // Still tracked, so a rebind onto Caps Lock mid-hold can't strand the
        // flag at `true` and swallow the next hold's flip.
        assert!(d.caps_held);
        assert!(!decide(VK_CAPITAL, Edge::Up, F8, 0, false, true).caps_held);
    }

    /// Blanket invariant across the whole VK range: nothing but a Caps Lock
    /// down edge, with Caps Lock bound to PTT, may ever synthesise a keystroke.
    #[test]
    fn flip_implies_caps_down_bound_to_ptt() {
        for vk in 0u32..=0xFF {
            for edge in [Edge::Down, Edge::Up, Edge::Other] {
                for ptt in [0, VK_CAPITAL, F8] {
                    for held in [false, true] {
                        let d = decide(vk, edge, ptt, F8, false, held);
                        if d.flip_caps {
                            assert_eq!(vk, VK_CAPITAL);
                            assert_eq!(ptt, VK_CAPITAL);
                            assert_eq!(edge, Edge::Down);
                            assert!(!held);
                        }
                    }
                }
            }
        }
    }

    /// The toggle-mute bind fires on the down edge only.
    #[test]
    fn toggle_fires_on_down_only() {
        assert_eq!(decide(F8, Edge::Down, 0, F8, false, false).emit, Emit::ToggleMute);
        assert_eq!(decide(F8, Edge::Up, 0, F8, false, false).emit, Emit::None);
        assert_eq!(decide(F8, Edge::Other, 0, F8, false, false).emit, Emit::None);
    }

    /// 0 means unbound: a vkCode of 0 must not match an unbound PTT or toggle.
    /// No real key reports 0, so this is a defensive invariant, not a live bug.
    #[test]
    fn unbound_zero_never_matches() {
        let d = decide(0, Edge::Down, 0, 0, false, false);
        assert_eq!(d.emit, Emit::None);
        assert!(!d.flip_caps);
    }
}
