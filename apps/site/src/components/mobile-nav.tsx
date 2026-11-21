import { MenuIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { navLinks, sourceUrl } from "./nav-links";

// The navigation on narrow screens: a menu button that opens a sheet.
export const MobileNav = () => {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open menu">
          <MenuIcon />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-[min(320px,85vw)] gap-2 overflow-y-auto p-4"
      >
        <SheetHeader className="p-2">
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription className="sr-only">
            Pages on this site
          </SheetDescription>
        </SheetHeader>
        <nav aria-label="Mobile" className="flex flex-col gap-1">
          {navLinks.map((link) => (
            <Button
              key={link.href}
              asChild
              variant="ghost"
              className="h-12 justify-start rounded-xl px-3 text-base"
            >
              <a href={link.href} onClick={close}>
                {link.label}
              </a>
            </Button>
          ))}
        </nav>
        <Separator className="my-2" />
        <div className="flex flex-col gap-2">
          <Button asChild size="lg">
            <a href="/#self-host" onClick={close}>
              Get Billy
            </a>
          </Button>
          <Button asChild variant="outline" size="lg">
            <a href={sourceUrl}>Read the source</a>
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};
