// Wi-Fi の受信状態を JSON Lines で標準出力に流し続ける。
//   {"type":"link", ...}  0.1 秒ごと: 接続中の電波 (RSSI / ノイズ / 速度 / チャンネル)
//   {"type":"scan", ...}  スキャンが終わるたび: 周りのアクセスポイント一覧
// 親プロセスが閉じると書き込みに失敗して終了する。
import CoreWLAN
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: obj),
        let line = String(data: data, encoding: .utf8) else { return }
  print(line)
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

guard let iface = CWWiFiClient.shared().interface() else {
  emit(["type": "error", "message": "Wi-Fi インターフェースが見つかりません"])
  exit(1)
}

let linkInterval = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 0.1
let scanGap = 8.0 // スキャン終了から次のスキャンまでの間隔 (秒)

Timer.scheduledTimer(withTimeInterval: linkInterval, repeats: true) { _ in
  let ch = iface.wlanChannel()
  var obj: [String: Any] = [
    "type": "link",
    "t": nowMs(),
    "iface": iface.interfaceName ?? "",
    "power": iface.powerOn(),
    "rssi": iface.rssiValue(),
    "noise": iface.noiseMeasurement(),
    "rate": iface.transmitRate(),
    "txPower": iface.transmitPower(),
    "phy": iface.activePHYMode().rawValue,
  ]
  if let ch = ch {
    obj["channel"] = ch.channelNumber
    obj["band"] = ch.channelBand.rawValue
    obj["width"] = ch.channelWidth.rawValue
  }
  if let ssid = iface.ssid() { obj["ssid"] = ssid }
  emit(obj)
}

let scanQueue = DispatchQueue(label: "scan")
func scheduleScan(after delay: Double) {
  scanQueue.asyncAfter(deadline: .now() + delay) {
    let t0 = Date()
    do {
      let nets = try iface.scanForNetworks(withSSID: nil)
      let list: [[String: Any]] = nets.map { n in
        var o: [String: Any] = ["rssi": n.rssiValue]
        if let s = n.ssid { o["ssid"] = s }
        if let b = n.bssid { o["bssid"] = b }
        if let c = n.wlanChannel {
          o["channel"] = c.channelNumber
          o["band"] = c.channelBand.rawValue
          o["width"] = c.channelWidth.rawValue
        }
        return o
      }
      let ms = Date().timeIntervalSince(t0) * 1000
      DispatchQueue.main.async { emit(["type": "scan", "t": nowMs(), "durationMs": ms, "nets": list]) }
    } catch {
      DispatchQueue.main.async { emit(["type": "scanError", "t": nowMs(), "message": "\(error.localizedDescription)"]) }
    }
    scheduleScan(after: scanGap)
  }
}
scheduleScan(after: 0.5)

RunLoop.main.run()
