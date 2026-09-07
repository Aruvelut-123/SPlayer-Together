package top.imsyy.splayer.android.playback;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class PlaybackActionReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null || intent.getAction() == null) {
      return;
    }

    PlaybackManager.getInstance(context).handleNotificationAction(intent.getAction());
  }
}
