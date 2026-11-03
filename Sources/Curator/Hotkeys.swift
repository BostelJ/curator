import Carbon.HIToolbox
import Foundation

/// Global keys, through Carbon's hot key API: works from any app and needs no Accessibility permission.
/// A registered key is taken away from the app in front, so overlay keys are only held while they're needed.
final class Hotkeys {
    enum Key: UInt32, CaseIterable {
        case left = 1, right, enter, escape, undo
        case keep, noteAny, noteBare, deleteAny, deleteBare
        case gallery, bringBack

        var combo: (code: Int, modifiers: Int) {
            let hyper = controlKey | optionKey
            switch self {
            case .left: return (kVK_LeftArrow, 0)
            case .right: return (kVK_RightArrow, 0)
            case .enter: return (kVK_Return, 0)
            case .escape: return (kVK_Escape, 0)
            case .undo: return (kVK_ANSI_Z, hyper)
            case .keep: return (kVK_ANSI_K, hyper)
            case .noteAny: return (kVK_ANSI_N, hyper)
            case .noteBare: return (kVK_ANSI_N, 0)
            case .deleteAny: return (kVK_Delete, hyper)
            case .deleteBare: return (kVK_Delete, 0)
            case .gallery: return (kVK_ANSI_G, hyper)
            case .bringBack: return (kVK_ANSI_P, hyper)
            }
        }
    }

    private var registered: [Key: EventHotKeyRef] = [:]
    private let onPress: (Key) -> Void
    private static var instance: Hotkeys?

    init(onPress: @escaping (Key) -> Void) {
        self.onPress = onPress
        Hotkeys.instance = self
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            if let key = Key(rawValue: id.id) { Hotkeys.instance?.onPress(key) }
            return noErr
        }, 1, &spec, nil, nil)
    }

    /// Make the held keys exactly this set.
    func hold(_ wanted: Set<Key>) {
        for (key, ref) in registered where !wanted.contains(key) {
            UnregisterEventHotKey(ref)
            registered[key] = nil
        }
        for key in wanted where registered[key] == nil {
            var ref: EventHotKeyRef?
            let id = EventHotKeyID(signature: OSType(0x43555241), id: key.rawValue) // "CURA"
            let status = RegisterEventHotKey(UInt32(key.combo.code), UInt32(key.combo.modifiers), id,
                                             GetApplicationEventTarget(), 0, &ref)
            if status == noErr, let ref {
                registered[key] = ref
            } else {
                NSLog("Curator: couldn't hold hot key \(key): \(status)")
            }
        }
    }
}
