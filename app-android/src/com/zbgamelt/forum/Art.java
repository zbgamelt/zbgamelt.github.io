package com.zbgamelt.forum;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.view.View;

/**
 * 空状态 / 错误状态的小插画：一个安静的对话气泡。纯代码画的，不用图片资源。
 */
public final class Art extends View {

    private final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);

    public Art(Context c) {
        super(c);
        p.setStyle(Paint.Style.STROKE);
        p.setStrokeWidth(Ui.dp(c, 3));
    }

    @Override
    protected void onMeasure(int w, int h) {
        setMeasuredDimension(Ui.dp(getContext(), 128), Ui.dp(getContext(), 96));
    }

    @Override
    protected void onDraw(Canvas cv) {
        Context c = getContext();
        float w = getWidth();
        float h = getHeight();
        int inset = Ui.dp(c, 6);
        RectF box = new RectF(inset, inset, w - inset, h - inset);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(0xFF2C3138);
        cv.drawRoundRect(box, Ui.dp(c, 20), Ui.dp(c, 20), p);

        p.setStyle(Paint.Style.FILL);
        p.setColor(0xFF3C424B);
        float cy = (box.top + box.bottom) / 2f;
        for (int i = -1; i <= 1; i++) {
            cv.drawCircle(w / 2f + i * Ui.dp(c, 16), cy, Ui.dp(c, 3.6f), p);
        }
    }
}
