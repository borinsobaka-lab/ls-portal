import { Toaster as Sonner } from "sonner";
import { InfoCircle, CheckCircle, CloseCircle, DangerTriangle } from "@solar-icons/react";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      position="top-center"
      className="toaster group"
      icons={{
        info: <InfoCircle weight="Bold" className="h-5 w-5 text-primary" />,
        success: <CheckCircle weight="Bold" className="h-5 w-5 text-[#22C55E]" />,
        error: <CloseCircle weight="Bold" className="h-5 w-5 text-[#EF4444]" />,
        warning: <DangerTriangle weight="Bold" className="h-5 w-5 text-primary" />,
      }}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: "group toast !rounded-2xl",
          title: "!text-white !font-medium",
          description: "!text-white/70",
          icon: "!mr-2",
          actionButton: "group-[.toast]:!bg-primary group-[.toast]:!text-primary-foreground",
          cancelButton: "group-[.toast]:!bg-white/10 group-[.toast]:!text-white",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
